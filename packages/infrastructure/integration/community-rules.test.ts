import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import { describe, it, expect, beforeAll } from "vitest";
import {
  httpFetch,
  waitForReachable,
  login,
  directusRequest,
  applySchema,
  mergeSchemas,
  discoverSchemaFiles,
  findUserByEmail,
} from "../src/directus/client";
import { communityPolicies, type CommunityRuleFields } from "../src/crm/community-rules";

// Applies the Community role's rules (../src/crm/community-rules.ts - the same data ../src/crm/
// index.ts turns into Pulumi resources) against a throwaway dev/directus-local instance, then
// checks the fixtures from the design doc for #166. Run via `just directus-community-test`
// (scripts/directus-community-test), which brings the instance up first - never run directly
// against a shared instance. Excluded from the default `vitest run` (vitest.config.ts's include),
// since it needs Docker and a Directus license.
//
// Directus enforces relational permission filters only with a license
// (packages/infrastructure/src/infrastructure/directus.ts) - a missing key must fail this test
// loudly, not silently pass with nothing actually checked.
if (!process.env["DIRECTUS_LICENSE_KEY"]) {
  throw new Error(
    "DIRECTUS_LICENSE_KEY is required to run the Community rules integration test (it is never " +
      "skipped) - see docs/manual-setup.md §3/§9, and run it via `just directus-community-test`.",
  );
}

const baseUrl = "http://localhost:8055";
const adminEmail = "directus@example.com";
const adminPassword = "directus";

// Not a hard requirement of the data model - just distinct role/policy names so a re-run against a
// container that wasn't torn down doesn't collide with a stale one.
const runId = Date.now().toString(36);

let adminToken: string;
const roleId: { value: string } = { value: "" };
const personId: Record<string, string> = {};
const userToken: Record<string, string> = {};
const registrationId: Record<string, string> = {};
const shareContactByKey: Record<string, boolean | null> = {};

const YEARS_AGO = (years: number): string => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
};
const DAYS_FROM_NOW = (days: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

async function createItem<T extends Record<string, unknown>>(collection: string, data: T): Promise<{ id: string }> {
  const res = await directusRequest<{ data: { id: string } }>(
    baseUrl,
    adminToken,
    "POST",
    `/items/${collection}`,
    data,
  );
  return res.data;
}

async function createRule(policyId: string, rule: CommunityRuleFields): Promise<void> {
  await directusRequest(baseUrl, adminToken, "POST", "/permissions", {
    policy: policyId,
    collection: rule.collection,
    action: rule.action,
    permissions: rule.permissions ?? {},
    fields: rule.fields,
  });
}

/** Creates a local-password Community-role account with exactly the given (possibly mixed-case)
 * email - the "b@" fixture below deliberately stores it as "B@..." and then logs in as "b@...",
 * relying on Directus's login lookup being case-insensitive even though the stored column preserves
 * whatever case was set. Deletes a same-email account left over from a prior iteration first - the
 * emails are fixed, not `runId`-scoped, so `scripts/directus-community-test KEEP=1` (a still-running
 * container reused across iterations) would otherwise fail on Directus's unique-email constraint. */
async function createFixtureUserAccount(email: string, password: string): Promise<void> {
  const existing = await findUserByEmail(baseUrl, adminToken, email);
  if (existing) {
    await directusRequest(baseUrl, adminToken, "DELETE", `/users/${existing}`);
  }
  await directusRequest(baseUrl, adminToken, "POST", "/users", {
    email,
    password,
    role: roleId.value,
    provider: "default",
    status: "active",
  });
}

async function createFixtureUser(email: string, password: string): Promise<string> {
  await createFixtureUserAccount(email, password);
  return login(baseUrl, email, password);
}

/** A signed-in fixture user's own view - never throws on a non-2xx status, since 403 is an expected
 * outcome for several assertions below. */
async function asUser(token: string, method: string, path: string, body?: unknown) {
  const res = await httpFetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json() };
}

async function readAs(token: string, collection: string, query = ""): Promise<{ status: number; data: unknown[] }> {
  const { status, body } = await asUser(token, "GET", `/items/${collection}${query}`);
  return { status, data: status === 200 ? (body as { data: unknown[] }).data : [] };
}

beforeAll(async () => {
  // Fresh podman database migrations run well over a minute; the default reachability timeout is
  // tuned for a VM that's already up, not this.
  await waitForReachable(baseUrl, 5 * 60_000);
  adminToken = await login(baseUrl, adminEmail, adminPassword);

  // 1. The merged schema - same discovery/merge client.ts's applySchema uses in production.
  // discoverSchemaFiles wants the `packages/` directory itself (one level down is each
  // `<package>/schema.yaml`) - crm/index.ts's own `__dirname` is one level deeper than this file's,
  // so this resolves with one less `..` than that call does.
  const schemaFiles = discoverSchemaFiles(resolve(__dirname, "../../"));
  const schemas = schemaFiles.map(({ name, path }) => ({ name, schema: yaml.load(readFileSync(path, "utf8")) }));
  await applySchema(baseUrl, adminToken, mergeSchemas(schemas));

  // 2. The Community role and its three policies, from the exact data crm/index.ts ships.
  const role = await directusRequest<{ data: { id: string } }>(baseUrl, adminToken, "POST", "/roles", {
    name: `Community (test ${runId})`,
  });
  roleId.value = role.data.id;

  for (const policyData of communityPolicies) {
    const policy = await directusRequest<{ data: { id: string } }>(baseUrl, adminToken, "POST", "/policies", {
      name: `${policyData.name} (test ${runId})`,
      app_access: false,
    });
    await directusRequest(baseUrl, adminToken, "POST", "/access", { role: roleId.value, policy: policy.data.id });
    for (const rule of policyData.rules) {
      await createRule(policy.data.id, rule);
    }
  }

  // 3. Fixtures - two programs (P, Q), an active camp and an ended one, one class of P in each.
  const programP = await createItem("programs", { name: `Program P (${runId})` });
  const programQ = await createItem("programs", { name: `Program Q (${runId})` });

  await createItem("camps", {
    id: `camp-active-${runId}`,
    name: "Active Camp",
    start_date: DAYS_FROM_NOW(-7),
    end_date: DAYS_FROM_NOW(7),
  });
  await createItem("camps", {
    id: `camp-ended-${runId}`,
    name: "Ended Camp",
    start_date: DAYS_FROM_NOW(-60),
    end_date: DAYS_FROM_NOW(-30),
  });
  await createItem("sessions", { id: `session-active-${runId}`, camp_id: `camp-active-${runId}` });
  await createItem("sessions", { id: `session-ended-${runId}`, camp_id: `camp-ended-${runId}` });
  await createItem("classes", {
    id: `class-p-${runId}`,
    name: "Class P",
    camp_id: `camp-active-${runId}`,
    program_id: programP.id,
  });
  await createItem("classes", {
    id: `class-p-ended-${runId}`,
    name: "Class P (ended)",
    camp_id: `camp-ended-${runId}`,
    program_id: programP.id,
  });
  await createItem("classes", {
    id: `class-q-${runId}`,
    name: "Class Q",
    camp_id: `camp-active-${runId}`,
    program_id: programQ.id,
  });

  // A `people` row for every fixture person, keyed by the short names the design doc's table uses.
  // Guardians are distinct `people` rows from their wards, even where they share an email address
  // (a family commonly does) - the `contacts` policy is what makes them visible as separate rows.
  // The opt-in itself lives on each person's `registrations` row, not here (#166 step 4).
  const people: Record<string, Record<string, unknown>> = {
    guardianA: { first_name: "Guardian", last_name: "A", email: "a@example.com", date_of_birth: YEARS_AGO(40) },
    A1: { first_name: "A1", last_name: "Kid", email: "a@example.com", date_of_birth: YEARS_AGO(10), school: "North" },
    guardianB: { first_name: "Guardian", last_name: "B", email: "B@example.com", date_of_birth: YEARS_AGO(40) },
    B1: { first_name: "B1", last_name: "Kid", email: "b1@example.com", date_of_birth: YEARS_AGO(11), school: "South" },
    C: { first_name: "C", last_name: "Adult", email: "c@example.com", date_of_birth: YEARS_AGO(30), school: "North" },
    D: { first_name: "D", last_name: "NoDob", email: "d@example.com", date_of_birth: null, school: "North" },
    guardianE: { first_name: "Guardian", last_name: "E", email: "e@example.com", date_of_birth: YEARS_AGO(40) },
    E1: { first_name: "E1", last_name: "Kid", email: "e1@example.com", date_of_birth: YEARS_AGO(9), school: "Q" },
    guardianI: { first_name: "Guardian", last_name: "I", email: "i@example.com", date_of_birth: YEARS_AGO(40) },
    I1: { first_name: "I1", last_name: "Kid", email: "i1@example.com", date_of_birth: YEARS_AGO(12), school: "North" },
    // Shares its guardian's email, like A1/guardianA above - the `family` policy's guardian branch.
    guardianF: { first_name: "Guardian", last_name: "F", email: "f@example.com", date_of_birth: YEARS_AGO(40) },
    F1: { first_name: "F1", last_name: "Kid", email: "f@example.com", date_of_birth: YEARS_AGO(10), school: "North" },
    // A minor with their own email and no guardian fixture - signs in as themselves, but ADULT
    // fails, so the `family` policy grants them nothing (#166).
    T1: { first_name: "T1", last_name: "Teen", email: "t@example.com", date_of_birth: YEARS_AGO(15), school: "North" },
    // `people.email` is neither login address below - these two only prove `ME` reaches a person
    // through `contact_point_links` (#166 step 1).
    G: {
      first_name: "G",
      last_name: "Multi",
      email: "g-other@example.com",
      date_of_birth: YEARS_AGO(30),
      school: "North",
    },
    H: {
      first_name: "H",
      last_name: "Stale",
      email: "h-other@example.com",
      date_of_birth: YEARS_AGO(30),
      school: "North",
    },
  };
  for (const [key, fields] of Object.entries(people)) {
    personId[key] = (await createItem("people", fields)).id;
  }

  // G has two current addresses - a recent `form` row and a `staff` row with no `last_seen_at` -
  // and H has only a `form` row last seen two years ago, which `CURRENT_EMAIL_POINT` excludes.
  await createItem("contact_points", {
    person_id: personId["G"],
    kind: "email",
    value: "g-form@example.com",
    normalized: "g-form@example.com",
    source: "form",
    last_seen_at: DAYS_FROM_NOW(-30),
  });
  await createItem("contact_points", {
    person_id: personId["G"],
    kind: "email",
    value: "g-staff@example.com",
    normalized: "g-staff@example.com",
    source: "staff",
    last_seen_at: null,
  });
  await createItem("contact_points", {
    person_id: personId["H"],
    kind: "email",
    value: "h-stale@example.com",
    normalized: "h-stale@example.com",
    source: "form",
    last_seen_at: YEARS_AGO(2),
  });

  const guardianships: [string, string][] = [
    ["A1", "guardianA"],
    ["B1", "guardianB"],
    ["E1", "guardianE"],
    ["I1", "guardianI"],
    ["F1", "guardianF"],
  ];
  for (const [subjectKey, guardianKey] of guardianships) {
    await createItem("contacts", {
      subject_id: personId[subjectKey],
      contact_id: personId[guardianKey],
      relationship_type: "guardian",
    });
  }

  // A participant + registration + registration_entry per participation - the chain `TEAMMATE`
  // walks: people.participant_links -> participants.registrations -> registrations.registration_entries.
  // `share_contact` lives on the registration (#166 step 4), so each row carries its own answer;
  // A1 gets a second, opted-out registration in Q, proving the opt-in doesn't follow the person
  // across programs.
  const participations: {
    key: string;
    personKey: string;
    classId: string;
    campId: string;
    sessionId: string;
    shareContact: boolean | null;
  }[] = [
    {
      key: "A1",
      personKey: "A1",
      classId: `class-p-${runId}`,
      campId: `camp-active-${runId}`,
      sessionId: `session-active-${runId}`,
      shareContact: true,
    },
    {
      key: "A1-Q",
      personKey: "A1",
      classId: `class-q-${runId}`,
      campId: `camp-active-${runId}`,
      sessionId: `session-active-${runId}`,
      shareContact: false,
    },
    {
      key: "B1",
      personKey: "B1",
      classId: `class-p-${runId}`,
      campId: `camp-active-${runId}`,
      sessionId: `session-active-${runId}`,
      shareContact: null,
    },
    {
      key: "C",
      personKey: "C",
      classId: `class-p-${runId}`,
      campId: `camp-active-${runId}`,
      sessionId: `session-active-${runId}`,
      shareContact: true,
    },
    {
      key: "D",
      personKey: "D",
      classId: `class-p-${runId}`,
      campId: `camp-active-${runId}`,
      sessionId: `session-active-${runId}`,
      shareContact: true,
    },
    {
      key: "E1",
      personKey: "E1",
      classId: `class-q-${runId}`,
      campId: `camp-active-${runId}`,
      sessionId: `session-active-${runId}`,
      shareContact: true,
    },
    {
      key: "I1",
      personKey: "I1",
      classId: `class-p-ended-${runId}`,
      campId: `camp-ended-${runId}`,
      sessionId: `session-ended-${runId}`,
      shareContact: true,
    },
    {
      key: "F1",
      personKey: "F1",
      classId: `class-p-${runId}`,
      campId: `camp-active-${runId}`,
      sessionId: `session-active-${runId}`,
      shareContact: null,
    },
    {
      key: "T1",
      personKey: "T1",
      classId: `class-p-${runId}`,
      campId: `camp-active-${runId}`,
      sessionId: `session-active-${runId}`,
      shareContact: null,
    },
    {
      key: "G",
      personKey: "G",
      classId: `class-p-${runId}`,
      campId: `camp-active-${runId}`,
      sessionId: `session-active-${runId}`,
      shareContact: true,
    },
    {
      key: "H",
      personKey: "H",
      classId: `class-p-${runId}`,
      campId: `camp-active-${runId}`,
      sessionId: `session-active-${runId}`,
      shareContact: true,
    },
  ];
  for (const { key, personKey, classId, campId, sessionId, shareContact } of participations) {
    const participantId = `participant-${key}-${runId}`;
    const id = `registration-${key}-${runId}`;
    registrationId[key] = id;
    shareContactByKey[key] = shareContact;
    await createItem("participants", { id: participantId, person_id: personId[personKey] });
    await createItem("registrations", {
      id,
      camp_id: campId,
      registered_at: new Date().toISOString(),
      status: "confirmed",
      participant_id: participantId,
      share_contact: shareContact,
    });
    await createItem("registration_entries", {
      id: `entry-${key}-${runId}`,
      registration_id: id,
      session_id: sessionId,
      class_id: classId,
      status: "confirmed",
    });
  }
  // 4. The fixture logins - local password users on the Community role, keyed on email exactly like
  // a real Authentik sign-in (matched against `people.email` with no other link).
  userToken["a"] = await createFixtureUser("a@example.com", "password-a");
  // Stored on the account as "B@..." (matching guardianB's people.email), logged in as "b@..." -
  // proves a login typed in a different case still reaches the same account.
  await createFixtureUserAccount("B@example.com", "password-b");
  userToken["b"] = await login(baseUrl, "b@example.com", "password-b");
  userToken["c"] = await createFixtureUser("c@example.com", "password-c");
  userToken["d"] = await createFixtureUser("d@example.com", "password-d");
  userToken["e"] = await createFixtureUser("e@example.com", "password-e");
  userToken["i"] = await createFixtureUser("i@example.com", "password-i");
  userToken["f"] = await createFixtureUser("f@example.com", "password-f");
  userToken["t"] = await createFixtureUser("t@example.com", "password-t");
  userToken["x"] = await createFixtureUser("x@example.com", "password-x");
  userToken["g-form"] = await createFixtureUser("g-form@example.com", "password-g-form");
  userToken["g-staff"] = await createFixtureUser("g-staff@example.com", "password-g-staff");
  userToken["h-stale"] = await createFixtureUser("h-stale@example.com", "password-h-stale");
}, 300_000);

describe("Community role rules (#166)", () => {
  it("a@ reads names A1, B1, C, D - no E1, no I1", async () => {
    const { data } = await readAs(userToken["a"]!, "people");
    const ids = new Set((data as { id: string }[]).map((row) => row.id));
    expect(ids).toContain(personId["A1"]);
    expect(ids).toContain(personId["B1"]);
    expect(ids).toContain(personId["C"]);
    expect(ids).toContain(personId["D"]);
    expect(ids).not.toContain(personId["E1"]);
    expect(ids).not.toContain(personId["I1"]);
  });

  it("a@ reads email/phone for guardian A and C only, scoped to those policy fields", async () => {
    const { data } = await readAs(userToken["a"]!, "people");
    const rows = data as Record<string, unknown>[];
    const byId = new Map(rows.map((row) => [row["id"], row]));

    const guardianARow = byId.get(personId["guardianA"]);
    expect(guardianARow).toBeDefined();
    expect(guardianARow?.["email"]).toBe("a@example.com");

    const cRow = byId.get(personId["C"]);
    expect(cRow).toBeDefined();
    expect(cRow?.["email"]).toBe("c@example.com");

    // Directus projects the `email`/`phone` columns for every row once *any* policy on the role
    // grants them (here, the `contacts` policy) - a row whose own filter doesn't match gets the
    // column back as `null`, not omitted, so `guardianB`'s and `B1`'s absence (no policy matches
    // either row for a@) and `A1`'s and `D`'s masking (present, but not opted-in as an adult) both
    // read the same way: never the real value.
    for (const key of ["A1", "guardianB", "B1", "D"]) {
      const row = byId.get(personId[key]);
      expect(row?.["email"]).toBeFalsy();
      expect(row?.["phone"]).toBeFalsy();
    }
  });

  it("b@ (stored as B@) sees the same names and the same contacts - case normalization", async () => {
    const { data } = await readAs(userToken["b"]!, "people");
    const rows = data as Record<string, unknown>[];
    const ids = new Set(rows.map((row) => row["id"]));
    expect(ids).toContain(personId["A1"]);
    expect(ids).toContain(personId["B1"]);
    expect(ids).toContain(personId["C"]);
    expect(ids).toContain(personId["D"]);

    const byId = new Map(rows.map((row) => [row["id"], row]));
    expect(byId.get(personId["guardianA"])?.["email"]).toBe("a@example.com");
    expect(byId.get(personId["C"])?.["email"]).toBe("c@example.com");
  });

  it("e@ reads E1, guardian E, and A1 by name only; no guardian A contact; i@ reads nothing in P (I1's only class is in an ended camp)", async () => {
    const eResult = await readAs(userToken["e"]!, "people");
    const eRows = eResult.data as Record<string, unknown>[];
    const eIds = new Set(eRows.map((row) => row["id"]));
    // Guardian E appears too, same as guardian A does for a@ above - E1 opted in, and guardian E is
    // E1's guardian contact, so the `contacts` policy grants guardian E's row. A1 appears by name
    // only - its registration in Q makes it e@'s teammate there, but that registration opted out,
    // so neither A1's nor guardian A's contact info comes along (#166).
    expect(eIds).toEqual(new Set([personId["E1"], personId["guardianE"], personId["A1"]]));
    const a1Row = eRows.find((row) => row["id"] === personId["A1"]);
    expect(a1Row?.["email"]).toBeFalsy();
    expect(eIds).not.toContain(personId["guardianA"]);

    const iResult = await readAs(userToken["i"]!, "people");
    expect(iResult.data).toEqual([]);
  });

  it("x@ (no match) gets an empty list", async () => {
    const { data } = await readAs(userToken["x"]!, "people");
    expect(data).toEqual([]);
  });

  it("a@ can toggle A1's registration share_contact, and b@ loses guardian A's contact on the next read", async () => {
    const patch = await asUser(userToken["a"]!, "PATCH", `/items/registrations/${registrationId["A1"]}`, {
      share_contact: false,
    });
    expect(patch.status).toBeLessThan(300);

    const { data } = await readAs(userToken["b"]!, "people");
    const rows = data as Record<string, unknown>[];
    const guardianARow = rows.find((row) => row["id"] === personId["guardianA"]);
    expect(guardianARow?.["email"]).toBeUndefined();

    // Revert, so later assertions see A1's original opt-in.
    const revert = await asUser(userToken["a"]!, "PATCH", `/items/registrations/${registrationId["A1"]}`, {
      share_contact: true,
    });
    expect(revert.status).toBeLessThan(300);
  });

  it("a@ cannot patch B1's registration or A1's camp_id; d@ cannot patch D's; c@ can patch its own share_contact", async () => {
    const aOnB1 = await asUser(userToken["a"]!, "PATCH", `/items/registrations/${registrationId["B1"]}`, {
      share_contact: true,
    });
    expect(aOnB1.status).toBeGreaterThanOrEqual(400);

    // camp_id is never in the update rule's field list, even on a row a@ can otherwise write.
    const aOnA1CampId = await asUser(userToken["a"]!, "PATCH", `/items/registrations/${registrationId["A1"]}`, {
      camp_id: `camp-ended-${runId}`,
    });
    expect(aOnA1CampId.status).toBeGreaterThanOrEqual(400);

    // D has no dob and no guardian fixture, so FAMILY_SELF grants d@ nothing - not even D's own row.
    const dOnSelf = await asUser(userToken["d"]!, "PATCH", `/items/registrations/${registrationId["D"]}`, {
      share_contact: true,
    });
    expect(dOnSelf.status).toBeGreaterThanOrEqual(400);

    const cOnSelf = await asUser(userToken["c"]!, "PATCH", `/items/registrations/${registrationId["C"]}`, {
      share_contact: false,
    });
    expect(cOnSelf.status).toBeLessThan(300);

    const revert = await asUser(userToken["c"]!, "PATCH", `/items/registrations/${registrationId["C"]}`, {
      share_contact: true,
    });
    expect(revert.status).toBeLessThan(300);
  });

  it("a@ reads B1's registration through the names policy only - camp_id/share_contact masked, not family's to write", async () => {
    const registrations = await readAs(
      userToken["a"]!,
      "registrations",
      `?filter[participant_id][_eq]=participant-B1-${runId}`,
    );
    expect(registrations.data).toHaveLength(1);
    const row = registrations.data[0] as Record<string, unknown>;
    // The field superset spans both registrations-read rules on the role (names' id-only pair and
    // family's four) - B1's row only matches names' filter, so family's two extra fields come back
    // null rather than omitted, the same masking the email/phone fields get above.
    expect(Object.keys(row).sort()).toEqual(["camp_id", "id", "participant_id", "share_contact"]);
    expect(row["camp_id"]).toBeNull();
    expect(row["share_contact"]).toBeNull();

    const participants = await readAs(userToken["a"]!, "participants", `?filter[id][_eq]=participant-B1-${runId}`);
    expect(participants.data).toHaveLength(1);
    expect(Object.keys(participants.data[0] as object).sort()).toEqual(["id", "person_id"]);
  });

  it("every fixture login gets 403 or an empty list from medical_profiles and contact_points", async () => {
    for (const token of Object.values(userToken)) {
      for (const collection of ["medical_profiles", "contact_points"]) {
        const { status, body } = await asUser(token, "GET", `/items/${collection}`);
        if (status === 200) {
          expect((body as { data: unknown[] }).data).toEqual([]);
        } else {
          expect(status).toBe(403);
        }
      }
    }
  });

  // The `family` policy no longer has its own `contacts` read - the toggle derives its write target
  // from `registrations`, not a guardian link (#166 step 4). So this read comes only from the
  // `contacts` policy's `SHARED_GUARDIAN_LINK`, scoped to a guardian whose child has an opted-in
  // registration the viewer shares a program with: i@ loses it (I1's only registration is in an
  // ended camp), and f@/t@ never had it (F1 hasn't opted in; T1 has no guardian fixture).
  it("a contacts read is scoped to an opted-in guardian link, never another family's", async () => {
    const expected: Record<string, [string, string] | null> = {
      a: [personId["A1"]!, personId["guardianA"]!],
      b: [personId["B1"]!, personId["guardianB"]!],
      c: null,
      d: null,
      e: [personId["E1"]!, personId["guardianE"]!],
      i: null,
      f: null,
      t: null,
      x: null,
    };
    for (const [key, pair] of Object.entries(expected)) {
      const { data } = await readAs(userToken[key]!, "contacts");
      const rows = data as { subject_id: string; contact_id: string; relationship_type: string }[];
      if (pair === null) {
        expect(rows).toEqual([]);
        continue;
      }
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ subject_id: pair[0], contact_id: pair[1], relationship_type: "guardian" });
    }
  });

  it("every login's writable registrations are exactly what its PATCH of share_contact accepts (#166)", async () => {
    for (const token of Object.values(userToken)) {
      const { data } = await readAs(token, "registrations");
      const writableIds = new Set(
        (data as Record<string, unknown>[]).filter((row) => row["camp_id"] != null).map((row) => row["id"]),
      );

      for (const [key, id] of Object.entries(registrationId)) {
        const patch = await asUser(token, "PATCH", `/items/registrations/${id}`, { share_contact: true });
        if (writableIds.has(id)) {
          expect(patch.status).toBeLessThan(300);
          const revert = await asUser(token, "PATCH", `/items/registrations/${id}`, {
            share_contact: shareContactByKey[key] ?? null,
          });
          expect(revert.status).toBeLessThan(300);
        } else {
          expect(patch.status).toBeGreaterThanOrEqual(400);
        }
      }
    }
  });

  it("g-form@ and g-staff@ both resolve to G through contact_point_links, not people.email (#166)", async () => {
    const writableOf = async (token: string) => {
      const { data } = await readAs(token, "registrations");
      return new Set(
        (data as Record<string, unknown>[]).filter((row) => row["camp_id"] != null).map((row) => row["id"]),
      );
    };
    const formWritable = await writableOf(userToken["g-form"]!);
    const staffWritable = await writableOf(userToken["g-staff"]!);
    expect(formWritable).toEqual(staffWritable);
    expect(formWritable).toContain(registrationId["G"]);
  });

  it("a form contact point last seen two years ago matches nobody - h-stale@ can't write even H's own registration (#166)", async () => {
    const { data } = await readAs(userToken["h-stale"]!, "registrations");
    const writable = (data as Record<string, unknown>[]).filter((row) => row["camp_id"] != null);
    expect(writable).toEqual([]);
  });

  // Finding 5, #166: a filter or search term on a field the role can't read must not let a@ learn
  // whether it matches B1 - not even indirectly, through which rows come back. If any of these
  // leaks a B1 row, stop and report; don't ship `contacts` until a design fixes it.
  it("a@'s people filters can't be used to probe B1's email or phone", async () => {
    const probes = ["?filter[email][_starts_with]=b1", "?filter[phone][_nnull]=true", "?search=b1@"];
    for (const query of probes) {
      const { data } = await readAs(userToken["a"]!, "people", query);
      const ids = new Set((data as { id: string }[]).map((row) => row.id));
      expect(ids).not.toContain(personId["B1"]);
    }
  });
});
