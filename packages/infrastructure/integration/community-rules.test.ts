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
  const people: Record<string, Record<string, unknown>> = {
    guardianA: { first_name: "Guardian", last_name: "A", email: "a@example.com", date_of_birth: YEARS_AGO(40) },
    A1: {
      first_name: "A1",
      last_name: "Kid",
      email: "a@example.com",
      date_of_birth: YEARS_AGO(10),
      school: "North",
      share_contact: true,
    },
    guardianB: { first_name: "Guardian", last_name: "B", email: "B@example.com", date_of_birth: YEARS_AGO(40) },
    B1: { first_name: "B1", last_name: "Kid", email: "b1@example.com", date_of_birth: YEARS_AGO(11), school: "South" },
    C: {
      first_name: "C",
      last_name: "Adult",
      email: "c@example.com",
      date_of_birth: YEARS_AGO(30),
      school: "North",
      share_contact: true,
    },
    D: {
      first_name: "D",
      last_name: "NoDob",
      email: "d@example.com",
      date_of_birth: null,
      school: "North",
      share_contact: true,
    },
    guardianE: { first_name: "Guardian", last_name: "E", email: "e@example.com", date_of_birth: YEARS_AGO(40) },
    E1: {
      first_name: "E1",
      last_name: "Kid",
      email: "e1@example.com",
      date_of_birth: YEARS_AGO(9),
      school: "Q",
      share_contact: true,
    },
    guardianI: { first_name: "Guardian", last_name: "I", email: "i@example.com", date_of_birth: YEARS_AGO(40) },
    I1: {
      first_name: "I1",
      last_name: "Kid",
      email: "i1@example.com",
      date_of_birth: YEARS_AGO(12),
      school: "North",
      share_contact: true,
    },
  };
  for (const [key, fields] of Object.entries(people)) {
    personId[key] = (await createItem("people", fields)).id;
  }

  const guardianships: [string, string][] = [
    ["A1", "guardianA"],
    ["B1", "guardianB"],
    ["E1", "guardianE"],
    ["I1", "guardianI"],
  ];
  for (const [subjectKey, guardianKey] of guardianships) {
    await createItem("contacts", {
      subject_id: personId[subjectKey],
      contact_id: personId[guardianKey],
      relationship_type: "guardian",
    });
  }

  // A participant + registration + registration_entry per participating person - the chain
  // `TEAMMATE` walks: people.participant_links -> participants.registrations ->
  // registrations.registration_entries.
  const participations: { key: string; classId: string; campId: string; sessionId: string }[] = [
    { key: "A1", classId: `class-p-${runId}`, campId: `camp-active-${runId}`, sessionId: `session-active-${runId}` },
    { key: "B1", classId: `class-p-${runId}`, campId: `camp-active-${runId}`, sessionId: `session-active-${runId}` },
    { key: "C", classId: `class-p-${runId}`, campId: `camp-active-${runId}`, sessionId: `session-active-${runId}` },
    { key: "D", classId: `class-p-${runId}`, campId: `camp-active-${runId}`, sessionId: `session-active-${runId}` },
    { key: "E1", classId: `class-q-${runId}`, campId: `camp-active-${runId}`, sessionId: `session-active-${runId}` },
    {
      key: "I1",
      classId: `class-p-ended-${runId}`,
      campId: `camp-ended-${runId}`,
      sessionId: `session-ended-${runId}`,
    },
  ];
  for (const { key, classId, campId, sessionId } of participations) {
    const participantId = `participant-${key}-${runId}`;
    const registrationId = `registration-${key}-${runId}`;
    await createItem("participants", { id: participantId, person_id: personId[key] });
    await createItem("registrations", {
      id: registrationId,
      camp_id: campId,
      registered_at: new Date().toISOString(),
      status: "confirmed",
      participant_id: participantId,
    });
    await createItem("registration_entries", {
      id: `entry-${key}-${runId}`,
      registration_id: registrationId,
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
  userToken["x"] = await createFixtureUser("x@example.com", "password-x");
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

  it("e@ reads E1 and guardian E only; i@ reads nothing in P (I1's only class is in an ended camp)", async () => {
    const eResult = await readAs(userToken["e"]!, "people");
    const eIds = new Set((eResult.data as { id: string }[]).map((row) => row.id));
    // Guardian E appears too, same as guardian A does for a@ above - E1 opted in, and guardian E is
    // E1's guardian contact, so the `contacts` policy grants guardian E's row.
    expect(eIds).toEqual(new Set([personId["E1"], personId["guardianE"]]));

    const iResult = await readAs(userToken["i"]!, "people");
    expect(iResult.data).toEqual([]);
  });

  it("x@ (no match) gets an empty list", async () => {
    const { data } = await readAs(userToken["x"]!, "people");
    expect(data).toEqual([]);
  });

  it("a@ can toggle A1's share_contact, and b@ loses guardian A's contact on the next read", async () => {
    const patch = await asUser(userToken["a"]!, "PATCH", `/items/people/${personId["A1"]}`, { share_contact: false });
    expect(patch.status).toBeLessThan(300);

    const { data } = await readAs(userToken["b"]!, "people");
    const rows = data as Record<string, unknown>[];
    const guardianARow = rows.find((row) => row["id"] === personId["guardianA"]);
    expect(guardianARow?.["email"]).toBeUndefined();
  });

  it("a@ cannot patch B1 or A1's email; d@ cannot patch anything; c@ can patch its own share_contact", async () => {
    const aOnB1 = await asUser(userToken["a"]!, "PATCH", `/items/people/${personId["B1"]}`, { share_contact: false });
    expect(aOnB1.status).toBeGreaterThanOrEqual(400);

    const aOnA1Email = await asUser(userToken["a"]!, "PATCH", `/items/people/${personId["A1"]}`, {
      email: "changed@example.com",
    });
    expect(aOnA1Email.status).toBeGreaterThanOrEqual(400);

    const dOnSelf = await asUser(userToken["d"]!, "PATCH", `/items/people/${personId["D"]}`, { share_contact: false });
    expect(dOnSelf.status).toBeGreaterThanOrEqual(400);

    const cOnSelf = await asUser(userToken["c"]!, "PATCH", `/items/people/${personId["C"]}`, { share_contact: false });
    expect(cOnSelf.status).toBeLessThan(300);
  });

  it("a@ reads only the id-only joins for B1's participants/registrations rows", async () => {
    const registrations = await readAs(
      userToken["a"]!,
      "registrations",
      `?filter[participant_id][_eq]=participant-B1-${runId}`,
    );
    expect(registrations.data).toHaveLength(1);
    expect(Object.keys(registrations.data[0] as object).sort()).toEqual(["id", "participant_id"]);

    const participants = await readAs(userToken["a"]!, "participants", `?filter[id][_eq]=participant-B1-${runId}`);
    expect(participants.data).toHaveLength(1);
    expect(Object.keys(participants.data[0] as object).sort()).toEqual(["id", "person_id"]);
  });

  it("every fixture login gets 403 or an empty list from medical_profiles, contacts, and contact_points", async () => {
    for (const token of Object.values(userToken)) {
      for (const collection of ["medical_profiles", "contacts", "contact_points"]) {
        const { status, body } = await asUser(token, "GET", `/items/${collection}`);
        if (status === 200) {
          expect((body as { data: unknown[] }).data).toEqual([]);
        } else {
          expect(status).toBe(403);
        }
      }
    }
  });
});
