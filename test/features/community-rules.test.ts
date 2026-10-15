import { describeFeature } from "@amiceli/vitest-cucumber";
import { expect } from "vitest";
import { login } from "../../packages/infrastructure/src/directus/client";
import {
  ACTIVE_CAMP,
  PARENT_COORDINATOR,
  communityPolicies,
} from "../../packages/infrastructure/src/crm/community-rules";
import { feature } from "./feature";
import { asAdmin, deploymentEnv, directus, directusAdmin, newRunId, requiredDeploymentEnv } from "./support";

// Runs against the Community role and policies `crm` deployed to dev, so it checks what ships. The
// people, programs, and camps are this run's own; only the logins are deleted afterwards, since
// `mise run reset` empties the collections but keeps users.

type Row = Record<string, unknown>;

const runId = newRunId();
const email = (key: string) => `${key}.${runId}@example.test`;
const list = (names: string) => names.split(",").map((name) => name.trim());

const yearsAgo = (years: number) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
};
const daysFromNow = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// A1's and B1's phones, unique to the run, for the filter probes (#175).
const A1_PHONE = `+1206${runId.slice(-7)}`;
const B1_PHONE = `+1425${runId.slice(-7)}`;

// Guardians are their own `people` rows, even where they share their child's email. The opt-in
// lives on each registration, not here (#166 step 4).
const people: Record<string, Row> = {
  guardianA: { first_name: "Guardian", last_name: "A", email: email("a"), date_of_birth: yearsAgo(40) },
  A1: {
    first_name: "A1",
    last_name: "Kid",
    email: email("a"),
    phone: A1_PHONE,
    date_of_birth: yearsAgo(10),
    school: "North",
  },
  // Stored in another case than b signs in with (#175).
  guardianB: { first_name: "Guardian", last_name: "B", email: email("B"), date_of_birth: yearsAgo(40) },
  B1: {
    first_name: "B1",
    last_name: "Kid",
    email: email("b1"),
    phone: B1_PHONE,
    date_of_birth: yearsAgo(11),
    school: "South",
  },
  C: { first_name: "C", last_name: "Adult", email: email("c"), date_of_birth: yearsAgo(30), school: "North" },
  D: { first_name: "D", last_name: "NoDob", email: email("d"), date_of_birth: null, school: "North" },
  guardianE: { first_name: "Guardian", last_name: "E", email: email("e"), date_of_birth: yearsAgo(40) },
  E1: { first_name: "E1", last_name: "Kid", email: email("e1"), date_of_birth: yearsAgo(9), school: "Q" },
  guardianI: { first_name: "Guardian", last_name: "I", email: email("i"), date_of_birth: yearsAgo(40) },
  I1: { first_name: "I1", last_name: "Kid", email: email("i1"), date_of_birth: yearsAgo(12), school: "North" },
  // Shares its guardian's email, like A1: the `family` policy's guardian branch.
  guardianF: { first_name: "Guardian", last_name: "F", email: email("f"), date_of_birth: yearsAgo(40) },
  F1: { first_name: "F1", last_name: "Kid", email: email("f"), date_of_birth: yearsAgo(10), school: "North" },
  // A minor with their own email and no guardian: signs in, but ADULT fails, so `family` grants nothing.
  T1: { first_name: "T1", last_name: "Teen", email: email("t"), date_of_birth: yearsAgo(15), school: "North" },
  // A minor recorded as B1's second guardian. A coordinator must never see their email.
  minorGuardian: { first_name: "Minor", last_name: "Guardian", email: email("mg"), date_of_birth: yearsAgo(16) },
  // Coordinators have no children in any program, and a null date of birth like every Clubspot guardian.
  K: { first_name: "K", last_name: "Coordinator", email: email("k"), date_of_birth: null },
  M: { first_name: "M", last_name: "Helper", email: email("m"), date_of_birth: null },
  N: { first_name: "N", last_name: "Former", email: email("n"), date_of_birth: null },
};

const personId: Record<string, string> = {};
const registrationId: Record<string, string> = {};
const shareContactByKey: Record<string, boolean | null> = {};
const userToken: Record<string, string> = {};
const userIds: string[] = [];

async function createItem(collection: string, data: Row): Promise<{ id: string }> {
  return asAdmin("POST", `/items/${collection}`, data);
}

/** The Parent Coordinator role is matched by name, so every run shares one row of it. */
async function parentCoordinatorRole(): Promise<string> {
  const filter = encodeURIComponent(JSON.stringify({ name: { _eq: PARENT_COORDINATOR } }));
  const [existing] = await asAdmin("GET", `/items/program_roles?filter=${filter}&limit=1`);
  return existing?.id ?? (await createItem("program_roles", { name: PARENT_COORDINATOR })).id;
}

async function createFixtures(): Promise<void> {
  const camp = { active: `camp-active-${runId}`, ended: `camp-ended-${runId}` };
  const session = { active: `session-active-${runId}`, ended: `session-ended-${runId}` };
  const programP = await createItem("programs", { name: `Program P (${runId})` });
  const programQ = await createItem("programs", { name: `Program Q (${runId})` });
  await createItem("camps", {
    id: camp.active,
    name: "Active Camp",
    start_date: daysFromNow(-7),
    end_date: daysFromNow(7),
  });
  await createItem("camps", {
    id: camp.ended,
    name: "Ended Camp",
    start_date: daysFromNow(-60),
    end_date: daysFromNow(-30),
  });
  await createItem("sessions", { id: session.active, camp_id: camp.active });
  await createItem("sessions", { id: session.ended, camp_id: camp.ended });
  const classes = { p: `class-p-${runId}`, pEnded: `class-p-ended-${runId}`, q: `class-q-${runId}` };
  await createItem("classes", { id: classes.p, name: "Class P", camp_id: camp.active, program_id: programP.id });
  await createItem("classes", {
    id: classes.pEnded,
    name: "Class P (ended)",
    camp_id: camp.ended,
    program_id: programP.id,
  });
  await createItem("classes", { id: classes.q, name: "Class Q", camp_id: camp.active, program_id: programQ.id });

  for (const [key, fields] of Object.entries(people)) {
    personId[key] = (await createItem("people", fields)).id;
  }

  const guardianships = [
    ["A1", "guardianA"],
    ["B1", "guardianB"],
    ["E1", "guardianE"],
    ["I1", "guardianI"],
    ["F1", "guardianF"],
    ["B1", "minorGuardian"],
  ] as const;
  for (const [subject, guardian] of guardianships) {
    await createItem("contacts", {
      subject_id: personId[subject],
      contact_id: personId[guardian],
      relationship_type: "guardian",
    });
  }

  const coordinator = await parentCoordinatorRole();
  const otherRole = await createItem("program_roles", { name: `Volunteer (${runId})` });
  const assignments = [
    ["K", coordinator, null],
    ["M", otherRole.id, null],
    ["N", coordinator, daysFromNow(-3)],
  ] as const;
  for (const [person, role, endsOn] of assignments) {
    await createItem("program_role_assignments", {
      person_id: personId[person],
      program_id: programP.id,
      program_role_id: role,
      ends_on: endsOn,
    });
  }

  // A participant, registration, and entry per participation: the chain TEAMMATE walks. A1's second,
  // opted-out registration in Q shows the opt-in doesn't follow a person across programs.
  const active = { campId: camp.active, sessionId: session.active };
  const participations: {
    key: string;
    person: string;
    classId: string;
    campId: string;
    sessionId: string;
    share: boolean | null;
  }[] = [
    { key: "A1", person: "A1", classId: classes.p, ...active, share: true },
    { key: "A1-Q", person: "A1", classId: classes.q, ...active, share: false },
    { key: "B1", person: "B1", classId: classes.p, ...active, share: null },
    { key: "C", person: "C", classId: classes.p, ...active, share: true },
    { key: "D", person: "D", classId: classes.p, ...active, share: true },
    { key: "E1", person: "E1", classId: classes.q, ...active, share: true },
    { key: "I1", person: "I1", classId: classes.pEnded, campId: camp.ended, sessionId: session.ended, share: true },
    { key: "F1", person: "F1", classId: classes.p, ...active, share: null },
    { key: "T1", person: "T1", classId: classes.p, ...active, share: null },
  ];
  for (const { key, person, classId, campId, sessionId, share } of participations) {
    const participantId = `participant-${key}-${runId}`;
    const id = `registration-${key}-${runId}`;
    registrationId[key] = id;
    shareContactByKey[key] = share;
    await createItem("participants", { id: participantId, person_id: personId[person] });
    await createItem("registrations", {
      id,
      camp_id: campId,
      registered_at: new Date().toISOString(),
      status: "confirmed",
      participant_id: participantId,
      share_contact: share,
    });
    await createItem("registration_entries", {
      id: `entry-${key}-${runId}`,
      registration_id: id,
      session_id: sessionId,
      class_id: classId,
      status: "confirmed",
    });
  }

  // Local-password logins on the Community role, matched on email as an Authentik sign-in is.
  const { baseUrl } = await directusAdmin();
  const role = await requiredDeploymentEnv("directus", "AUTH_AUTHENTIK_DEFAULT_ROLE_ID");
  for (const key of ["a", "B", "c", "d", "e", "i", "f", "t", "x", "k", "m", "n"]) {
    const password = `password-${key}-${runId}`;
    const user = await asAdmin("POST", "/users", {
      email: email(key),
      password,
      role,
      provider: "default",
      status: "active",
    });
    userIds.push(user.id);
    userToken[key.toLowerCase()] = await login(baseUrl, email(key.toLowerCase()), password);
  }
}

let fixtures: Promise<void> | undefined;

async function asUser(login: string, method: string, path: string, body?: unknown) {
  const token = userToken[login];
  if (!token) {
    throw new Error(`No fixture login "${login}".`);
  }
  return directus(token, method, path, body);
}

async function readAs(login: string, collection: string, query = ""): Promise<{ status: number; data: Row[] }> {
  const { status, body } = await asUser(login, "GET", `/items/${collection}${query}`);
  return { status, data: status === 200 ? body.data : [] };
}

const ids = (rows: Row[]) => new Set(rows.map((row) => row["id"]));

/** The most relations any path through a rule's filter crosses. Keys that start with `_` are operators. */
function relationalDepth(filter: unknown): number {
  if (Array.isArray(filter)) {
    return Math.max(0, ...filter.map(relationalDepth));
  }
  if (typeof filter !== "object" || filter === null) {
    return 0;
  }
  return Math.max(
    0,
    ...Object.entries(filter).map(([key, value]) => {
      if (key.startsWith("_")) {
        return relationalDepth(value);
      }
      const isRelation =
        typeof value === "object" &&
        value !== null &&
        Object.keys(value).some((inner) => !inner.startsWith("_") || ["_and", "_or", "_some", "_none"].includes(inner));
      return isRelation ? 1 + relationalDepth(value) : 0;
    }),
  );
}

/** The roster page's requests (packages/portal/src/roster/browser.ts), by its own names. */
const rosterRequests: Record<string, { collection: string; fields: string[]; filter?: Row }> = {
  entriesUrl: {
    collection: "registration_entries",
    fields: [
      "id",
      "class_id.id",
      "class_id.name",
      "class_id.program_id.id",
      "class_id.program_id.name",
      "registration_id.id",
      "registration_id.participant_id.person_id",
    ],
    filter: { class_id: { camp_id: ACTIVE_CAMP } },
  },
  peopleUrl: { collection: "people", fields: ["id", "first_name", "last_name", "school", "email", "phone"] },
  guardianContactLinksUrl: { collection: "contacts", fields: ["subject_id", "contact_id", "relationship_type"] },
  // Community sends no filter.
  registrationsUrl: { collection: "registrations", fields: ["id", "camp_id", "participant_id", "share_contact"] },
  participantsUrl: { collection: "participants", fields: ["id", "person_id"] },
};

describeFeature(
  feature("community-rules.feature"),
  ({ Background, Scenario, ScenarioOutline, AfterAllScenarios, AfterEachScenario, defineSteps }) => {
    // What the last step read or wrote, for the steps after it.
    let rows: Row[] = [];
    let status = 0;
    let probes: Row[][] = [];
    let baseline: Set<unknown> = new Set();

    AfterEachScenario(() => {
      rows = [];
      status = 0;
      probes = [];
      baseline = new Set();
    });

    AfterAllScenarios(async () => {
      for (const id of userIds) {
        await asAdmin("DELETE", `/users/${id}`);
      }
    });

    defineSteps(({ Step }) => {
      Step("{string} reads people", async (_, login: string) => {
        ({ data: rows } = await readAs(login, "people"));
      });

      Step("{string} reads contacts", async (_, login: string) => {
        ({ data: rows } = await readAs(login, "contacts"));
      });

      Step("{string} reads registrations", async (_, login: string) => {
        ({ data: rows } = await readAs(login, "registrations"));
      });

      Step("they see {string}", (_, names: string) => {
        for (const name of list(names)) {
          expect(ids(rows), name).toContain(personId[name]);
        }
      });

      Step("they see exactly {string}", (_, names: string) => {
        expect(ids(rows)).toEqual(new Set(list(names).map((name) => personId[name])));
      });

      Step("they don't see {string}", (_, names: string) => {
        for (const name of list(names)) {
          expect(ids(rows), name).not.toContain(personId[name]);
        }
      });

      Step("they see nobody", () => {
        expect(rows).toEqual([]);
      });

      Step("they see the email of {string}", (_, names: string) => {
        for (const name of list(names)) {
          expect(rows.find((row) => row["id"] === personId[name])?.["email"], name).toBe(people[name]!["email"]);
        }
      });

      // Directus returns `email` and `phone` on every row once any policy grants them, and null on a
      // row whose own filter doesn't match, so a hidden value and a missing row read the same.
      Step("they see no email or phone for {string}", (_, names: string) => {
        for (const name of list(names)) {
          const row = rows.find((candidate) => candidate["id"] === personId[name]);
          expect(row?.["email"], name).toBeFalsy();
          expect(row?.["phone"], name).toBeFalsy();
        }
      });

      Step("they see {string} with no email or phone", (_, names: string) => {
        for (const name of list(names)) {
          const row = rows.find((candidate) => candidate["id"] === personId[name]);
          expect(row, name).toBeDefined();
          expect(row?.["email"], name).toBeFalsy();
          expect(row?.["phone"], name).toBeFalsy();
        }
      });

      Step("they see no email for {string}", (_, name: string) => {
        expect(rows.find((row) => row["id"] === personId[name])?.["email"]).toBeFalsy();
      });

      Step("they get no email for {string}", (_, name: string) => {
        expect(rows.find((row) => row["id"] === personId[name])?.["email"]).toBeUndefined();
      });

      const setShareContact = async (login: string, key: string, value: boolean | null) =>
        (await asUser(login, "PATCH", `/items/registrations/${registrationId[key]}`, { share_contact: value })).status;

      Step("{string} has opted out of sharing on the {string} registration", async (_, login: string, key: string) => {
        expect(await setShareContact(login, key, false)).toBeLessThan(300);
      });

      Step("{string} can opt back in on the {string} registration", async (_, login: string, key: string) => {
        expect(await setShareContact(login, key, true)).toBeLessThan(300);
      });

      Step("{string} can't set share_contact on the {string} registration", async (_, login: string, key: string) => {
        expect(await setShareContact(login, key, true)).toBeGreaterThanOrEqual(400);
      });

      // camp_id is never in the update rule's fields, even on a row the login may otherwise write.
      Step("{string} can't move the {string} registration to the ended camp", async (_, login: string, key: string) => {
        const { status } = await asUser(login, "PATCH", `/items/registrations/${registrationId[key]}`, {
          camp_id: `camp-ended-${runId}`,
        });
        expect(status).toBeGreaterThanOrEqual(400);
      });

      Step("{string} can opt out and back in on the {string} registration", async (_, login: string, key: string) => {
        expect(await setShareContact(login, key, false)).toBeLessThan(300);
        expect(await setShareContact(login, key, true)).toBeLessThan(300);
      });

      Step("{string} reads the {string} registration", async (_, login: string, key: string) => {
        ({ data: rows } = await readAs(
          login,
          "registrations",
          `?filter[participant_id][_eq]=participant-${key}-${runId}`,
        ));
      });

      Step("{string} reads the {string} participant", async (_, login: string, key: string) => {
        ({ data: rows } = await readAs(login, "participants", `?filter[id][_eq]=participant-${key}-${runId}`));
      });

      // The field superset spans every read rule on the role. A row that matches only the names
      // policy gets family's extra fields back as null, not omitted.
      Step("it has only the fields {string}", (_, fields: string) => {
        expect(rows).toHaveLength(1);
        expect(Object.keys(rows[0]!).sort()).toEqual(list(fields));
      });

      Step("its {string} are null", (_, fields: string) => {
        for (const field of list(fields)) {
          expect(rows[0]![field], field).toBeNull();
        }
      });

      Step("every login gets nothing from {string}", async (_, collections: string) => {
        for (const login of Object.keys(userToken)) {
          for (const collection of list(collections)) {
            const { status, body } = await asUser(login, "GET", `/items/${collection}`);
            if (status === 200) {
              expect(body.data, `${login} ${collection}`).toEqual([]);
            } else {
              expect(status, `${login} ${collection}`).toBe(403);
            }
          }
        }
      });

      Step("they see one link, with only the fields {string}", (_, fields: string) => {
        expect(rows).toHaveLength(1);
        expect(Object.keys(rows[0]!).sort()).toEqual(list(fields));
      });

      Step("{string} filters contacts for the subject {string}", async (_, login: string, key: string) => {
        ({ data: rows } = await readAs(login, "contacts", `?filter[subject_id][_eq]=${personId[key]}`));
      });

      Step("they see no links", () => {
        expect(rows).toEqual([]);
      });

      Step(
        "every login's share_contact updates succeed on the registrations it reads with a camp, and fail on the rest",
        async () => {
          for (const login of Object.keys(userToken)) {
            const { data } = await readAs(login, "registrations");
            const writable = new Set(data.filter((row) => row["camp_id"] != null).map((row) => row["id"]));
            for (const [key, id] of Object.entries(registrationId)) {
              const patch = await asUser(login, "PATCH", `/items/registrations/${id}`, { share_contact: true });
              if (writable.has(id)) {
                expect(patch.status, `${login} ${key}`).toBeLessThan(300);
                const revert = await asUser(login, "PATCH", `/items/registrations/${id}`, {
                  share_contact: shareContactByKey[key] ?? null,
                });
                expect(revert.status, `${login} ${key} revert`).toBeLessThan(300);
              } else {
                expect(patch.status, `${login} ${key}`).toBeGreaterThanOrEqual(400);
              }
            }
          }
        },
      );

      Step("they see links for the subjects {string}", (_, names: string) => {
        expect(new Set(rows.map((row) => row["subject_id"]))).toEqual(
          new Set(list(names).map((name) => personId[name])),
        );
      });

      Step("they see some, each with a null camp_id", () => {
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row["camp_id"]).toBeNull();
        }
      });

      Step("{string} read nothing from {string}", async (_, logins: string, collections: string) => {
        for (const login of list(logins)) {
          for (const collection of list(collections)) {
            const { data } = await readAs(login, collection);
            expect(data, `${login} ${collection}`).toEqual([]);
          }
        }
      });

      // #166's finding 5: if any of these returns B1, the contacts policy leaks.
      Step("{string} reads people with each query", async (_, login: string, table: { query: string }[]) => {
        const queries: Record<string, string> = {
          "filter[email][_starts_with]": `?filter[email][_starts_with]=b1.${runId}`,
          "filter[phone][_nnull]": "?filter[phone][_nnull]=true",
          search: `?search=${encodeURIComponent(`b1.${runId}@`)}`,
        };
        probes = [];
        for (const { query } of table) {
          probes.push((await readAs(login, "people", queries[query])).data);
        }
      });

      Step("none of them returns {string}", (_, name: string) => {
        for (const probe of probes) {
          expect(ids(probe)).not.toContain(personId[name]);
        }
      });

      Step("the deepest Community rule nests {int} relations", (_, depth: number) => {
        const deepest = Math.max(
          ...communityPolicies.flatMap((policy) => policy.rules.map((rule) => relationalDepth(rule.permissions))),
        );
        expect(deepest).toBe(depth);
      });

      Step("dev's Directus leaves MAX_RELATIONAL_DEPTH at its default of {int}", async () => {
        expect(await deploymentEnv("directus", "MAX_RELATIONAL_DEPTH")).toBeUndefined();
      });

      Step("{string} reads their permissions", async (_, login: string) => {
        const result = await asUser(login, "GET", "/permissions/me");
        expect(result.status).toBe(200);
        rows = [result.body.data];
      });

      Step("the registrations read is {string}", (_, access: string) => {
        expect((rows[0] as { registrations?: { read?: { access?: string } } }).registrations?.read?.access).toBe(
          access,
        );
      });
    });

    Background(({ Given }) => {
      Given("this run's Community fixtures on dev's Directus", async () => {
        fixtures ??= createFixtures();
        await fixtures;
      });
    });

    Scenario("A guardian reads their child's teammates by name", () => {});
    Scenario("A guardian reads contacts only for teammates who opted in", () => {});
    Scenario("A login in another case reaches the same account and the same rows", () => {});
    Scenario("A teammate from another program appears by name only, and an ended camp shows nobody", () => {});
    Scenario("A login that matches nobody sees nobody", () => {});
    Scenario("Opting out hides a guardian's contact on the next read", () => {});
    Scenario("A family writes only its own share_contact", () => {});
    Scenario("Another family's registration comes back through the names policy only", () => {});
    Scenario("Nobody reads medical profiles or contact points", () => {});
    // Two grants union here: contacts' SHARED_GUARDIAN_LINK, for a child's opted-in registration,
    // and family's MY_GUARDIAN_LINK, for the viewer's own link. i and f get theirs from family alone.
    ScenarioOutline(
      "A contacts read holds the viewer's own guardian link, never another family's",
      ({ When, Then }, variables) => {
        When('"<login>" reads contacts', async () => {
          ({ data: rows } = await readAs(variables["login"], "contacts"));
        });
        Then('they see the guardian links "<links>"', () => {
          const links: string = variables["links"];
          if (links === "") {
            expect(rows).toEqual([]);
            return;
          }
          const [subject, guardian] = links.split("-");
          expect(rows).toEqual([
            { subject_id: personId[subject!], contact_id: personId[guardian!], relationship_type: "guardian" },
          ]);
        });
      },
    );
    Scenario("The family policy's own guardian link shows three fields, and no one else's link", () => {});
    Scenario("Each login can update exactly the registrations it reads as its own", () => {});
    Scenario("A Parent Coordinator sees their program's guardians' contacts without an opt-in", () => {});
    Scenario("A Parent Coordinator reads their program's guardian links, and registrations with no camp", () => {});
    Scenario("Another role on the program, or an ended coordinator role, sees nothing", () => {});
    Scenario("A filter or search can't find a person whose contact is hidden", () => {});
    Scenario("The deepest rule resolves beyond Directus's default relational depth", () => {});
    ScenarioOutline(
      "A names-only viewer can't probe a hidden column with a filter",
      ({ When, Then, And }, variables) => {
        When(`"e" reads people with "<query>", for A1's real value and for one that matches nobody`, async () => {
          const query: string = variables["query"];
          const values: Record<string, [string, string]> = {
            "filter[email][_eq]": [email("a"), email("nobody")],
            "filter[email][_starts_with]": [`a.${runId}`, `nobody.${runId}`],
            "filter[email][_contains]": [`a.${runId}@`, `nobody.${runId}@`],
            "filter[phone][_eq]": [A1_PHONE, "+19999999999"],
            "filter[phone][_starts_with]": [A1_PHONE.slice(0, 9), "+1999"],
            search: [`a.${runId}`, `nobody.${runId}`],
          };
          baseline = ids((await readAs("e", "people")).data);
          for (const value of values[query]!) {
            const result = await asUser("e", "GET", `/items/people?${query}=${encodeURIComponent(value)}`);
            // Refusing the filter outright leaks nothing either.
            expect([200, 403], `${query}=${value}`).toContain(result.status);
            probes.push(result.status === 200 ? result.body.data : []);
          }
        });
        Then('both return the same people, without "A1"', () => {
          expect(ids(probes[0]!)).toEqual(ids(probes[1]!));
          expect(ids(probes[0]!)).not.toContain(personId["A1"]);
        });
        And(`neither returns anyone "e" can't already see`, () => {
          for (const probe of probes) {
            for (const id of ids(probe)) {
              expect(baseline).toContain(id);
            }
          }
        });
      },
    );
    ScenarioOutline("A names-only viewer can't probe whether a hidden column is set", ({ When, Then }, variables) => {
      When('"e" reads people with "<query>"', async () => {
        const result = await asUser("e", "GET", `/items/people?${variables["query"]}`);
        expect([200, 403]).toContain(result.status);
        rows = result.status === 200 ? result.body.data : [];
      });
      Then(`it doesn't return "A1"`, () => {
        expect(ids(rows)).not.toContain(personId["A1"]);
      });
    });
    Scenario("Directus reports Community's registrations read as partial", () => {});
    ScenarioOutline("The portal's roster requests succeed for a Community viewer", ({ When, Then }, variables) => {
      When(`"a" sends the roster's "<request>" request`, async () => {
        const request = rosterRequests[variables["request"]]!;
        const params = new URLSearchParams({ limit: "-1", fields: request.fields.join(",") });
        if (request.filter) {
          params.set("filter", JSON.stringify(request.filter));
        }
        ({ status } = await asUser("a", "GET", `/items/${request.collection}?${params.toString()}`));
      });
      Then("it succeeds", () => {
        expect(status).toBe(200);
      });
    });
  },
);
