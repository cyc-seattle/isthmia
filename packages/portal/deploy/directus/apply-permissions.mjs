// Creates the Staff/Coach/Guardian roles and policies for the people hub. Run once against a
// freshly-provisioned Directus instance, after `directus schema apply schema.yaml` (schema
// snapshots cover collections/fields/relations only — not roles, policies, or permissions).
//
// IMPORTANT: restart Directus after `schema apply`, before running this script. `schema apply`
// writes to the database directly (a CLI process, separate from the running server); the running
// server's in-memory schema cache doesn't pick up the new collections until it restarts, and
// requests against them fail with a confusing "You don't have permission to access collection ...
// or it does not exist" 403 in the meantime — confirmed hands-on while writing this script.
//
// Usage: DIRECTUS_URL=https://crm.cycsail.team DIRECTUS_EMAIL=... DIRECTUS_PASSWORD=... \
//        node apply-permissions.mjs
//
// Not idempotent — re-running against an instance that already has these roles/policies will
// create duplicates. Intended for a fresh instance right after schema apply (+ restart).
//
// See docs/people-hub-schema.md for the permission model this implements, and
// docs/manual-setup.md §6 for the license caveat: the Guardian policy's relational
// ($CURRENT_USER-scoped) filters require staying on Directus 11.x (BSL) — Directus 12+ (MSCL) gates
// custom permission rules behind a paid Enterprise license.

const baseUrl = process.env.DIRECTUS_URL ?? "http://localhost:8055";
const email = process.env.DIRECTUS_EMAIL;
const password = process.env.DIRECTUS_PASSWORD;

if (!email || !password) {
  console.error("Set DIRECTUS_EMAIL and DIRECTUS_PASSWORD (an admin account).");
  process.exit(1);
}

async function req(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

const loginRes = await fetch(`${baseUrl}/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password }),
});
if (!loginRes.ok) {
  throw new Error(`login failed: ${loginRes.status} ${await loginRes.text()}`);
}
const token = (await loginRes.json()).data.access_token;

// An O2M alias field on `people` reversing contacts.related_person_id, so permission filters can
// express "am I (the current Directus user) a guardian of this person". Not part of the schema
// snapshot's own fields/relations because it's alias-only (no DB column) and the reverse `one_field`
// has to be attached to the already-applied contacts.related_person_id relation.
console.log("adding people.guardian_links alias field");
await req("POST", "/fields/people", {
  field: "guardian_links",
  type: "alias",
  meta: {
    interface: "list-o2m",
    special: ["o2m"],
    note: "Reverse of contacts.related_person_id - the contacts rows where this person is the minor.",
  },
});

console.log("patching contacts.related_person_id relation to set one_field");
await req("PATCH", "/relations/contacts/related_person_id", {
  meta: { one_field: "guardian_links" },
});

async function createPolicy(name, icon, description) {
  return (await req("POST", "/policies", { name, icon, description })).data;
}

async function grant(policyId, collection, action, permissions = {}) {
  await req("POST", "/permissions", { policy: policyId, collection, action, permissions, fields: ["*"] });
}

async function createRoleWithPolicy(name, icon, description, policyId) {
  await req("POST", "/roles", { name, icon, description });
  const [role] = (await req("GET", `/roles?filter[name][_eq]=${encodeURIComponent(name)}`)).data;
  await req("POST", "/access", { role: role.id, policy: policyId });
  return role;
}

// --- Staff: full CRUD on every custom collection, including medical_profiles. ---
const allCollections = [
  "people",
  "medical_profiles",
  "contacts",
  "event_staff",
  "programs",
  "sessions",
  "classes",
  "session_classes",
  "entry_caps",
  "registrations",
  "registration_entries",
];

console.log("creating Staff policy + role");
const staffPolicy = await createPolicy(
  "Staff",
  "badge",
  "Full read/write on the people hub, including medical data. Workspace accounts only (native Google OIDC).",
);
for (const collection of allCollections) {
  for (const action of ["create", "read", "update", "delete"]) {
    await grant(staffPolicy.id, collection, action);
  }
}
await createRoleWithPolicy(
  "Staff",
  "badge",
  "CYC staff. Authenticates via Directus native Google OIDC, provisioned by an admin.",
  staffPolicy.id,
);

// --- Coach: KISS read-only roster access, no medical data. Not scoped to the coach's own
// sessions yet (see docs/people-hub-schema.md's Permission model) - a follow-up. ---
console.log("creating Coach policy + role");
const coachPolicy = await createPolicy(
  "Coach",
  "sports",
  "Read-only roster access (sessions/registration_entries/people). No medical_profiles. Not scoped to the coach's own sessions yet - KISS for now.",
);
for (const collection of ["sessions", "registration_entries", "people", "programs", "classes"]) {
  await grant(coachPolicy.id, collection, "read");
}
await createRoleWithPolicy("Coach", "sports", "Coaches. No login yet - needs #65's account-linking.", coachPolicy.id);

// --- Guardian: read own minors' people/medical_profiles/registrations/registration_entries,
// filtered through guardian_links (contacts where relationship_type == guardian). ---
function guardianFilter(pathToGuardianLinks) {
  return {
    [pathToGuardianLinks]: {
      _and: [{ relationship_type: { _eq: "guardian" } }, { person_id: { directus_user_id: { _eq: "$CURRENT_USER" } } }],
    },
  };
}

console.log("creating Guardian policy + role");
const guardianPolicy = await createPolicy(
  "Guardian",
  "family_restroom",
  "Read own minors' people/medical_profiles/registrations/registration_entries. Filtered through contacts. No login yet - needs #65's account-linking.",
);
await grant(guardianPolicy.id, "people", "read", guardianFilter("guardian_links"));
await grant(guardianPolicy.id, "medical_profiles", "read", guardianFilter("person_id.guardian_links"));
await grant(guardianPolicy.id, "registrations", "read", guardianFilter("person_id.guardian_links"));
await grant(
  guardianPolicy.id,
  "registration_entries",
  "read",
  guardianFilter("registration_id.person_id.guardian_links"),
);
await createRoleWithPolicy(
  "Guardian",
  "family_restroom",
  "Guardians. No login yet - needs #65's account-linking.",
  guardianPolicy.id,
);

console.log("Done: Staff, Coach, Guardian roles/policies created.");
