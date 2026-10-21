import { describeFeature } from "@amiceli/vitest-cucumber";
import { describe, expect, it } from "vitest";
import { login } from "../../packages/infrastructure/src/directus/client";
import {
  ACTIVE_CAMP,
  PARENT_COORDINATOR,
  communityPolicies,
} from "../../packages/infrastructure/src/crm/community-rules";
import { feature } from "./feature";
import {
  asAdmin,
  deploymentEnv,
  devDirectusLicensed,
  directus,
  directusAdmin,
  newRunId,
  requiredDeploymentEnv,
} from "./support";

// Runs against the Community role and policies `crm` deployed to dev, so it checks what ships. The
// people, programs, and camps are this run's own; only the logins are deleted afterwards, since
// `mise run reset` empties the collections but keeps users.

type Row = Record<string, unknown>;

const runId = newRunId();
// Directus checks a user's email against the real TLDs, so not `.test`.
const email = (key: string) => `${key}.${runId}@example.com`;
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

// Bart's and Todd's phones, unique to the run, for the filter probes (#175).
const BART_PHONE = `+1206${runId.slice(-7)}`;
const TODD_PHONE = `+1425${runId.slice(-7)}`;

// Guardians are their own `people` rows, even where they share their child's email. The opt-in
// lives on each registration, not here (#166 step 4).
const people: Record<string, Row> = {
  Marge: { first_name: "Marge", last_name: "Simpson", email: email("marge"), date_of_birth: yearsAgo(40) },
  // Shares Marge's email: the `family` policy's guardian branch, and a self match that ADULT stops.
  Bart: {
    first_name: "Bart",
    last_name: "Simpson",
    email: email("marge"),
    phone: BART_PHONE,
    date_of_birth: yearsAgo(13),
    school: "Springfield Elementary",
  },
  Ned: { first_name: "Ned", last_name: "Flanders", email: email("ned"), date_of_birth: yearsAgo(40) },
  Todd: {
    first_name: "Todd",
    last_name: "Flanders",
    email: email("todd"),
    phone: TODD_PHONE,
    date_of_birth: yearsAgo(12),
    school: "Springfield Christian",
  },
  // A minor recorded as Todd's second guardian. A coordinator must never see his email.
  Rod: { first_name: "Rod", last_name: "Flanders", email: email("rod"), date_of_birth: yearsAgo(16) },
  Lenny: {
    first_name: "Lenny",
    last_name: "Leonard",
    email: email("lenny"),
    date_of_birth: yearsAgo(30),
    school: "Springfield Elementary",
  },
  Moe: {
    first_name: "Moe",
    last_name: "Szyslak",
    email: email("moe"),
    date_of_birth: null,
    school: "Springfield Elementary",
  },
  Kirk: { first_name: "Kirk", last_name: "Van Houten", email: email("kirk"), date_of_birth: yearsAgo(40) },
  Milhouse: {
    first_name: "Milhouse",
    last_name: "Van Houten",
    email: email("milhouse"),
    date_of_birth: yearsAgo(12),
    school: "Springfield Elementary",
  },
  Helen: { first_name: "Helen", last_name: "Lovejoy", email: email("helen"), date_of_birth: yearsAgo(40) },
  Jessica: {
    first_name: "Jessica",
    last_name: "Lovejoy",
    email: email("jessica"),
    date_of_birth: yearsAgo(13),
    school: "Springfield Elementary",
  },
  Martha: { first_name: "Martha", last_name: "Prince", email: email("martha"), date_of_birth: yearsAgo(40) },
  Martin: {
    first_name: "Martin",
    last_name: "Prince",
    email: email("martin"),
    date_of_birth: yearsAgo(13),
    school: "Springfield Elementary",
  },
  // Sailed Laser only in the ended camp, with no guardian on file.
  Nelson: {
    first_name: "Nelson",
    last_name: "Muntz",
    email: email("nelson"),
    date_of_birth: yearsAgo(14),
    school: "Springfield Elementary",
  },
  // Shares his guardian's email, like Bart.
  Clancy: { first_name: "Clancy", last_name: "Wiggum", email: email("clancy"), date_of_birth: yearsAgo(40) },
  Ralph: {
    first_name: "Ralph",
    last_name: "Wiggum",
    email: email("clancy"),
    date_of_birth: yearsAgo(13),
    school: "Springfield Elementary",
  },
  // A minor with his own email and no guardian: signs in, but ADULT fails, so `family` grants nothing.
  Jimbo: {
    first_name: "Jimbo",
    last_name: "Jones",
    email: email("jimbo"),
    date_of_birth: yearsAgo(15),
    school: "Springfield Elementary",
  },
  // Coordinators have no children in any program, and a null date of birth like every Clubspot guardian.
  Edna: { first_name: "Edna", last_name: "Krabappel", email: email("edna"), date_of_birth: null },
  Seymour: { first_name: "Seymour", last_name: "Skinner", email: email("seymour"), date_of_birth: null },
  Willie: { first_name: "Willie", last_name: "MacDougal", email: email("willie"), date_of_birth: null },
};

// Each login's sign-in email. Ned's account is stored in lowercase, and he signs in in capitals
// (#175). Hans has no `people` row.
const logins: Record<string, string> = {
  Marge: email("marge"),
  Ned: email("NED"),
  Lenny: email("lenny"),
  Moe: email("moe"),
  Kirk: email("kirk"),
  Helen: email("helen"),
  Clancy: email("clancy"),
  Jimbo: email("jimbo"),
  Hans: email("hans"),
  Edna: email("edna"),
  Seymour: email("seymour"),
  Willie: email("willie"),
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
  const camp = { running: `camp-summer-2-${runId}`, ended: `camp-summer-1-${runId}` };
  const session = { running: `session-summer-2-${runId}`, ended: `session-summer-1-${runId}` };
  const laser = await createItem("programs", { name: `Laser Race Team (${runId})` });
  const optiGreen = await createItem("programs", { name: `Opti Green (${runId})` });
  const optiRed = await createItem("programs", { name: `Opti Red (${runId})` });
  await createItem("camps", {
    id: camp.running,
    name: "Summer Session 2",
    start_date: daysFromNow(-7),
    end_date: daysFromNow(7),
  });
  await createItem("camps", {
    id: camp.ended,
    name: "Summer Session 1",
    start_date: daysFromNow(-60),
    end_date: daysFromNow(-30),
  });
  await createItem("sessions", { id: session.running, camp_id: camp.running });
  await createItem("sessions", { id: session.ended, camp_id: camp.ended });
  const classes = {
    laser: `class-laser-2-${runId}`,
    laserEnded: `class-laser-1-${runId}`,
    optiGreen: `class-opti-green-2-${runId}`,
    optiRedEnded: `class-opti-red-1-${runId}`,
  };
  await createItem("classes", {
    id: classes.laser,
    name: "Laser Race Team",
    camp_id: camp.running,
    program_id: laser.id,
  });
  await createItem("classes", {
    id: classes.laserEnded,
    name: "Laser Race Team",
    camp_id: camp.ended,
    program_id: laser.id,
  });
  await createItem("classes", {
    id: classes.optiGreen,
    name: "Opti Green",
    camp_id: camp.running,
    program_id: optiGreen.id,
  });

  await createItem("classes", {
    id: classes.optiRedEnded,
    name: "Opti Red",
    camp_id: camp.ended,
    program_id: optiRed.id,
  });

  for (const [key, fields] of Object.entries(people)) {
    personId[key] = (await createItem("people", fields)).id;
  }

  const guardianships = [
    ["Bart", "Marge"],
    ["Todd", "Ned"],
    ["Todd", "Rod"],
    ["Milhouse", "Kirk"],
    ["Jessica", "Helen"],
    ["Martin", "Martha"],
    ["Ralph", "Clancy"],
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
    ["Edna", coordinator, null],
    ["Seymour", otherRole.id, null],
    ["Willie", coordinator, daysFromNow(-3)],
  ] as const;
  for (const [person, role, endsOn] of assignments) {
    await createItem("program_role_assignments", {
      person_id: personId[person],
      program_id: laser.id,
      program_role_id: role,
      ends_on: endsOn,
    });
  }

  // A participant, registration, and entry per participation: the chain TEAMMATE walks. Bart's
  // second, opted-out registration in Opti Green shows the opt-in doesn't follow him across programs.
  const running = { campId: camp.running, sessionId: session.running };
  const ended = { campId: camp.ended, sessionId: session.ended };
  const participations: {
    key: string;
    person: string;
    classId: string;
    campId: string;
    sessionId: string;
    share: boolean | null;
  }[] = [
    { key: "Bart", person: "Bart", classId: classes.laser, ...running, share: true },
    { key: "Bart-Opti", person: "Bart", classId: classes.optiGreen, ...running, share: false },
    { key: "Todd", person: "Todd", classId: classes.laser, ...running, share: null },
    { key: "Lenny", person: "Lenny", classId: classes.laser, ...running, share: true },
    { key: "Moe", person: "Moe", classId: classes.laser, ...running, share: true },
    { key: "Milhouse", person: "Milhouse", classId: classes.optiGreen, ...running, share: true },
    { key: "Jessica", person: "Jessica", classId: classes.optiRedEnded, ...ended, share: true },
    { key: "Martin", person: "Martin", classId: classes.optiRedEnded, ...ended, share: true },
    { key: "Nelson", person: "Nelson", classId: classes.laserEnded, ...ended, share: null },
    { key: "Ralph", person: "Ralph", classId: classes.laser, ...running, share: null },
    { key: "Jimbo", person: "Jimbo", classId: classes.laser, ...running, share: null },
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
  for (const [name, signIn] of Object.entries(logins)) {
    const password = `password-${name}-${runId}`;
    const user = await asAdmin("POST", "/users", {
      email: signIn.toLowerCase(),
      password,
      role,
      provider: "default",
      status: "active",
    });
    userIds.push(user.id);
    userToken[name] = await login(baseUrl, signIn, password);
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

// The feature is tagged @licensed: Directus's Core tier ignores the rules it checks.
if (!devDirectusLicensed()) {
  describe.skip("Feature: The Community role's rules (#166)", () => {
    it("is skipped: dev's Directus is unlicensed (crm:licensed is false in crm's Pulumi.dev.yaml, #172)", () => {});
  });
} else {
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
          (await asUser(login, "PATCH", `/items/registrations/${registrationId[key]}`, { share_contact: value }))
            .status;

        Step(
          "{string} has opted out of sharing on the {string} registration",
          async (_, login: string, key: string) => {
            expect(await setShareContact(login, key, false)).toBeLessThan(300);
          },
        );

        Step("{string} can opt back in on the {string} registration", async (_, login: string, key: string) => {
          expect(await setShareContact(login, key, true)).toBeLessThan(300);
        });

        Step("{string} can't set share_contact on the {string} registration", async (_, login: string, key: string) => {
          expect(await setShareContact(login, key, true)).toBeGreaterThanOrEqual(400);
        });

        // camp_id is never in the update rule's fields, even on a row the login may otherwise write.
        Step(
          "{string} can't move the {string} registration to the ended camp",
          async (_, login: string, key: string) => {
            const { status } = await asUser(login, "PATCH", `/items/registrations/${registrationId[key]}`, {
              camp_id: `camp-summer-1-${runId}`,
            });
            expect(status).toBeGreaterThanOrEqual(400);
          },
        );

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

        Step("every link has only the fields {string}", (_, fields: string) => {
          expect(rows.length).toBeGreaterThan(0);
          for (const row of rows) {
            expect(Object.keys(row).sort()).toEqual(list(fields));
          }
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

        // #166's finding 5: if any of these returns Todd, the contacts policy leaks.
        Step("{string} reads people with each query", async (_, login: string, table: { query: string }[]) => {
          const queries: Record<string, string> = {
            "filter[email][_starts_with]": `?filter[email][_starts_with]=todd.${runId}`,
            "filter[phone][_nnull]": "?filter[phone][_nnull]=true",
            search: `?search=${encodeURIComponent(`todd.${runId}@`)}`,
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

      Scenario(
        "Viewing the Laser Race Team, a guardian sees every teammate by name, whether or not they opted in",
        () => {},
      );
      Scenario("Marge doesn't see Nelson, who sailed Laser only in the ended camp", () => {});
      Scenario("A child in two programs has two teams, so Marge sees Milhouse from Opti Green", () => {});
      Scenario("A guardian reads contacts only for teammates who opted in", () => {});
      Scenario("A login in another case reaches the same account and the same rows", () => {});
      Scenario("A teammate from another program appears by name only", () => {});
      Scenario("Once a camp ends, a family sees only itself", () => {});
      Scenario("A login that matches nobody sees nobody", () => {});
      Scenario("Opting out hides a guardian's contact on the next read", () => {});
      Scenario("A family writes only its own share_contact", () => {});
      Scenario("Another family's registration comes back through the names policy only", () => {});
      Scenario("Nobody reads medical profiles or contact points", () => {});
      // Two grants union here: family's MY_GUARDIAN_LINK, for the viewer's own link, and contacts'
      // SHARED_GUARDIAN_LINK, for an opted-in teammate's, which the roster needs to place a guardian.
      ScenarioOutline(
        "A contacts read holds the viewer's own guardian link, and opted-in teammates' links",
        ({ When, Then }, variables) => {
          When('"<login>" reads contacts', async () => {
            ({ data: rows } = await readAs(variables["login"], "contacts"));
          });
          Then('they see the guardian links "<links>"', () => {
            const links: string = variables["links"];
            const expected = links === "" ? [] : list(links).map((link) => link.split("-"));
            expect(rows).toHaveLength(expected.length);
            expect(rows).toEqual(
              expect.arrayContaining(
                expected.map(([subject, guardian]) => ({
                  subject_id: personId[subject!],
                  contact_id: personId[guardian!],
                  relationship_type: "guardian",
                })),
              ),
            );
          });
        },
      );
      Scenario("A guardian link shows three fields, and never a link the viewer has no reason to see", () => {});
      Scenario("Each login can update exactly the registrations it reads as its own", () => {});
      Scenario("A Parent Coordinator sees their program's guardians' contacts without an opt-in", () => {});
      Scenario("A Parent Coordinator reads their program's guardian links, and registrations with no camp", () => {});
      Scenario("Another role on the program, or an ended coordinator role, sees nothing", () => {});
      Scenario("A filter or search can't find a person whose contact is hidden", () => {});
      Scenario("The deepest rule resolves beyond Directus's default relational depth", () => {});
      ScenarioOutline(
        "A names-only viewer can't probe a hidden column with a filter",
        ({ When, Then, And }, variables) => {
          When(
            `"Kirk" reads people with "<query>", for Bart's real value and for one that matches nobody`,
            async () => {
              const query: string = variables["query"];
              const values: Record<string, [string, string]> = {
                "filter[email][_eq]": [email("marge"), email("nobody")],
                "filter[email][_starts_with]": [`marge.${runId}`, `nobody.${runId}`],
                "filter[email][_contains]": [`marge.${runId}@`, `nobody.${runId}@`],
                "filter[phone][_eq]": [BART_PHONE, "+19999999999"],
                "filter[phone][_starts_with]": [BART_PHONE.slice(0, 9), "+1999"],
                search: [`marge.${runId}`, `nobody.${runId}`],
                "filter[my_contacts][contact_id][email][_eq]": [email("marge"), email("nobody")],
                "filter[my_contacts][contact_id][email][_starts_with]": [`marge.${runId}`, `nobody.${runId}`],
              };
              baseline = ids((await readAs("Kirk", "people")).data);
              for (const value of values[query]!) {
                const result = await asUser("Kirk", "GET", `/items/people?${query}=${encodeURIComponent(value)}`);
                // Refusing the filter outright leaks nothing either.
                expect([200, 403], `${query}=${value}`).toContain(result.status);
                probes.push(result.status === 200 ? result.body.data : []);
              }
            },
          );
          Then('both return the same people, without "Bart"', () => {
            expect(ids(probes[0]!)).toEqual(ids(probes[1]!));
            expect(ids(probes[0]!)).not.toContain(personId["Bart"]);
          });
          And(`neither returns anyone "Kirk" can't already see`, () => {
            for (const probe of probes) {
              for (const id of ids(probe)) {
                expect(baseline).toContain(id);
              }
            }
          });
        },
      );
      ScenarioOutline("A names-only viewer can't probe whether a hidden column is set", ({ When, Then }, variables) => {
        When('"Kirk" reads people with "<query>"', async () => {
          const result = await asUser("Kirk", "GET", `/items/people?${variables["query"]}`);
          expect([200, 403]).toContain(result.status);
          rows = result.status === 200 ? result.body.data : [];
        });
        Then(`it doesn't return "Bart"`, () => {
          expect(ids(rows)).not.toContain(personId["Bart"]);
        });
      });
      ScenarioOutline(
        "A names-only viewer can't sort, group, or aggregate on a hidden column",
        ({ When, Then }, variables) => {
          When('"Kirk" reads people with "<query>"', async () => {
            ({ status } = await asUser("Kirk", "GET", `/items/people?${variables["query"]}`));
          });
          Then("Directus refuses it", () => {
            expect(status).toBe(403);
          });
        },
      );
      Scenario("Directus reports Community's registrations read as partial", () => {});
      ScenarioOutline("The portal's roster requests succeed for a Community viewer", ({ When, Then }, variables) => {
        When(`"Marge" sends the roster's "<request>" request`, async () => {
          const request = rosterRequests[variables["request"]]!;
          const params = new URLSearchParams({ limit: "-1", fields: request.fields.join(",") });
          if (request.filter) {
            params.set("filter", JSON.stringify(request.filter));
          }
          ({ status } = await asUser("Marge", "GET", `/items/${request.collection}?${params.toString()}`));
        });
        Then("it succeeds", () => {
          expect(status).toBe(200);
        });
      });
    },
  );
}
