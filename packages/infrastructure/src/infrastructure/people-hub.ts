import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import {
  DirectusRole,
  DirectusUser,
  DirectusSchema,
  DirectusPermissionRule,
  DirectusPermissionRuleFields,
  collectionsInSchema,
} from "../directus/index.js";
import { directusAdminBootstrapPassword, directusDatabase } from "./directus";
import { internalDomain } from "./dns";
import { substrateApply } from "./substrate-apply";

// The people hub app's own Directus schema/roles/policies, matching docs/people-hub-schema.md. A
// second Directus-backed app would define its own schema/roles in its own file, reusing the
// Directus* resources (../directus/) against the same instance.

const config = new pulumi.Config();
// Same default as substrate-bootstrap.ts's DIRECTUS_ADMIN_EMAIL — kept as a separate read (not a
// shared import) to avoid a cycle: compute.ts -> substrate-bootstrap.ts, and this file must not be
// part of that chain.
const directusAdminEmail = config.get("directusAdminEmail") ?? "master@cyccommunitysailing.org";

const baseUrl = pulumi.interpolate`https://directus.${internalDomain}`;

// The bootstrap admin's actual password — not just a reference to the secret container, the value
// itself — because these resources authenticate to the Directus API as that admin to create
// schema/roles/users. This is the one place in the program that reads a Secret Manager value
// rather than just declaring/granting the container; it never leaves the deployer's own
// `pulumi up` process, which already has legitimate access to it (they're the one who set it, or
// in this case, the one Pulumi generated it for — see directus.ts).
//
// `dependsOn: directusAdminBootstrapPassword.version` matters: `getSecretVersionOutput` takes a
// plain secret ID string, which carries no implicit dependency, so without this Pulumi has no way
// to know this read must happen after that secret's value is actually written — it would otherwise
// run immediately, failing on a fresh deploy where the secret doesn't exist yet even though this
// same `pulumi up` is about to create it.
const adminPassword = gcp.secretmanager
  .getSecretVersionOutput(
    { secret: "directus-admin-bootstrap-password" },
    { dependsOn: directusAdminBootstrapPassword.version },
  )
  .apply((version) => version.secretData);

const auth = { baseUrl, adminEmail: directusAdminEmail, adminPassword };

// The schema snapshot itself — collections/fields/relations, including the guardian_links alias
// field the Guardian role's filters below depend on. Applied via Directus's own REST API
// (schema/diff + schema/apply), not the CLI — see directus.ts's DirectusSchema for why that also
// sidesteps a schema-cache-staleness gotcha the CLI path has.
const schemaContent = readFileSync(resolve(__dirname, "../../../people-hub/schema.yaml"), "utf8");
const schema = yaml.load(schemaContent);

// Two edges, both required, and everything else here depends on this resource in turn:
// substrateApply (#107) is when the Directus container is guaranteed reconciled, and
// directusDatabase (#112) is when Directus owns its database - without that, `/schema/apply`
// returns 204 having created nothing.
export const peopleHubSchema = new DirectusSchema(
  "people-hub-schema",
  { ...auth, schema },
  { dependsOn: [substrateApply, directusDatabase] },
);

// Derived from schema.yaml itself (see #109) rather than hand-maintained, so it can't drift from
// what the schema actually declares.
const allCollections = collectionsInSchema(schema);

export const staffRole = new DirectusRole(
  "people-hub-staff",
  {
    ...auth,
    name: "Staff",
    icon: "badge",
    description:
      "Full read/write on the people hub, including medical data. Workspace accounts only (native Google OIDC).",
    appAccess: true,
  },
  { dependsOn: peopleHubSchema },
);

// Full read/write across every collection - one DirectusPermissionRule per (collection, action)
// pair, rather than an input on the role itself, so a future project can add or drop a Staff rule
// without an update that clobbers every other one (see the design doc's "Permission rules become
// their own resource").
for (const collection of allCollections) {
  for (const action of ["create", "read", "update", "delete"] as const) {
    new DirectusPermissionRule(
      `people-hub-staff-${collection}-${action}`,
      { ...auth, policyId: staffRole.policyId, collection, action },
      { dependsOn: staffRole },
    );
  }
}

export const coachRole = new DirectusRole(
  "people-hub-coach",
  {
    ...auth,
    name: "Coach",
    icon: "sports",
    description:
      "Read-only roster access (sessions/registration_entries/people). No medical_profiles. Not scoped to the " +
      "coach's own sessions yet - KISS for now, see docs/people-hub-schema.md.",
    appAccess: true,
  },
  { dependsOn: peopleHubSchema },
);

for (const collection of ["sessions", "registration_entries", "people", "programs", "classes"]) {
  new DirectusPermissionRule(
    `people-hub-coach-${collection}-read`,
    { ...auth, policyId: coachRole.policyId, collection, action: "read" },
    { dependsOn: coachRole },
  );
}

// Filters through the `guardian_links` alias field on `people` (baked into
// packages/people-hub/schema.yaml — reverses contacts.related_person_id) to express "am I
// (the signed-in Directus user) a guardian of this person".
function guardianFilter(pathToGuardianLinks: string): Record<string, unknown> {
  return {
    [pathToGuardianLinks]: {
      _and: [{ relationship_type: { _eq: "guardian" } }, { person_id: { directus_user_id: { _eq: "$CURRENT_USER" } } }],
    },
  };
}

export const guardianRole = new DirectusRole(
  "people-hub-guardian",
  {
    ...auth,
    name: "Guardian",
    icon: "family_restroom",
    description:
      "Read own minors' people/medical_profiles/registrations/registration_entries. Filtered through contacts. " +
      "No login yet - needs #65's account-linking.",
    // Guardians will eventually sign in through a future end-user-facing portal, not the Directus
    // Data Studio itself - API-only access.
    appAccess: false,
  },
  { dependsOn: peopleHubSchema },
);

const guardianRules: DirectusPermissionRuleFields[] = [
  { collection: "people", action: "read", permissions: guardianFilter("guardian_links") },
  { collection: "medical_profiles", action: "read", permissions: guardianFilter("person_id.guardian_links") },
  { collection: "registrations", action: "read", permissions: guardianFilter("person_id.guardian_links") },
  {
    collection: "registration_entries",
    action: "read",
    permissions: guardianFilter("registration_id.person_id.guardian_links"),
  },
];
for (const rule of guardianRules) {
  new DirectusPermissionRule(
    `people-hub-guardian-${rule.collection}-${rule.action}`,
    { ...auth, policyId: guardianRole.policyId, ...rule },
    { dependsOn: guardianRole },
  );
}

// The first real Staff account: ungood, via Google OIDC — no password, no manual "sign in as the
// bootstrap admin and create my account" dance. Provisioning more staff this way (rather than
// through the Directus UI) is a reasonable next step once there's a list of who needs access; for
// now this is just the one account actually doing the deploying.
export const ungoodUser = new DirectusUser("people-hub-staff-ungood", {
  ...auth,
  email: "ungood@onetrue.name",
  roleId: staffRole.roleId,
  provider: "google",
  externalIdentifier: "ungood@onetrue.name",
});
