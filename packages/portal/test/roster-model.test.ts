import { describe, it, expect } from "vitest";
import {
  ACTIVE_CAMP_FILTER,
  buildRoster,
  familyIds,
  familyMembers,
  familyOptedIn,
  filterMembers,
  groupByProgram,
  guardianContactsByChild,
  normalizeSchool,
  schoolOptions,
  teamOptions,
  type RawEntry,
  type RawGuardianLink,
  type RawPerson,
} from "../src/roster/model.js";

function entry(overrides: Partial<RawEntry> = {}): RawEntry {
  return {
    id: "entry-1",
    class_id: { id: "class-j", name: "J-Pod", program_id: { id: "prog-race", name: "Race Team" } },
    registration_id: { participant_id: { person_id: "person-1" } },
    ...overrides,
  };
}

describe("buildRoster", () => {
  it("joins an entry to its person through the registration/participant chain", () => {
    const people: RawPerson[] = [{ id: "person-1", first_name: "Ada", last_name: "Lovelace", school: "Lakeside" }];
    const [member] = buildRoster([entry()], people);
    expect(member).toMatchObject({
      personId: "person-1",
      fullName: "Ada Lovelace",
      school: "Lakeside",
      programId: "prog-race",
      programName: "Race Team",
      teamName: "J-Pod",
    });
  });

  it("drops an entry with no matching people row", () => {
    expect(buildRoster([entry()], [])).toEqual([]);
  });

  it("drops an entry missing its class or program chain", () => {
    const people: RawPerson[] = [{ id: "person-1", first_name: "Ada", last_name: "Lovelace" }];
    expect(buildRoster([entry({ class_id: null })], people)).toEqual([]);
    expect(buildRoster([entry({ registration_id: { participant_id: null } })], people)).toEqual([]);
  });

  it("falls back to a placeholder name when both name fields are blank", () => {
    const people: RawPerson[] = [{ id: "person-1", first_name: null, last_name: null }];
    const [member] = buildRoster([entry()], people);
    expect(member?.fullName).toBe("(name withheld)");
  });

  it("only shows email and phone when Directus actually returned them", () => {
    const people: RawPerson[] = [{ id: "person-1", first_name: "Ada", last_name: "Lovelace" }];
    const [member] = buildRoster([entry()], people);
    expect(member?.email).toBeNull();
    expect(member?.phone).toBeNull();

    const peopleWithContact: RawPerson[] = [
      { id: "person-1", first_name: "Ada", last_name: "Lovelace", email: "ada@example.com", phone: "555-1234" },
    ];
    const [withContact] = buildRoster([entry()], peopleWithContact);
    expect(withContact?.email).toBe("ada@example.com");
    expect(withContact?.phone).toBe("555-1234");
  });

  it("dedupes the same person on the same team seen through more than one entry", () => {
    const people: RawPerson[] = [{ id: "person-1", first_name: "Ada", last_name: "Lovelace" }];
    const members = buildRoster([entry({ id: "entry-1" }), entry({ id: "entry-2" })], people);
    expect(members).toHaveLength(1);
  });

  it("defaults to no guardian contacts when none are given", () => {
    const people: RawPerson[] = [{ id: "person-1", first_name: "Ada", last_name: "Lovelace" }];
    const [member] = buildRoster([entry()], people);
    expect(member?.guardianContacts).toEqual([]);
  });

  it("attaches a child's shared guardian contacts from the map, by person id", () => {
    const people: RawPerson[] = [{ id: "person-1", first_name: "Ada", last_name: "Lovelace" }];
    const guardianContacts = new Map([
      ["person-1", [{ personId: "g1", fullName: "Gail Guardian", email: "g@example.com", phone: null }]],
    ]);
    const [member] = buildRoster([entry()], people, guardianContacts);
    expect(member?.guardianContacts).toEqual([
      { personId: "g1", fullName: "Gail Guardian", email: "g@example.com", phone: null },
    ]);
  });
});

describe("groupByProgram", () => {
  it("groups members under their program, sorted by program name", () => {
    const people: RawPerson[] = [
      { id: "p1", first_name: "Ada", last_name: "A" },
      { id: "p2", first_name: "Bea", last_name: "B" },
    ];
    const entries = [
      entry(),
      entry({
        id: "entry-2",
        class_id: { id: "class-k", name: "K-Pod", program_id: { id: "prog-learn", name: "Learn to Sail" } },
        registration_id: { participant_id: { person_id: "p2" } },
      }),
    ];
    const members = buildRoster(entries, [{ ...people[0]!, id: "person-1" }, people[1]!]);
    const groups = groupByProgram(members);
    expect(groups.map((g) => g.programName)).toEqual(["Learn to Sail", "Race Team"]);
    expect(groups[1]?.members).toHaveLength(1);
  });
});

describe("filterMembers", () => {
  const people: RawPerson[] = [
    { id: "p1", first_name: "Ada", last_name: "A", school: "Lakeside" },
    { id: "p2", first_name: "Bea", last_name: "B", school: "lakeside " },
    { id: "p3", first_name: "Cal", last_name: "C", school: "Roosevelt" },
  ];
  const entries = [
    entry({ id: "e1", registration_id: { participant_id: { person_id: "p1" } } }),
    entry({ id: "e2", registration_id: { participant_id: { person_id: "p2" } } }),
    entry({
      id: "e3",
      class_id: { id: "class-k", name: "K-Pod", program_id: { id: "prog-race", name: "Race Team" } },
      registration_id: { participant_id: { person_id: "p3" } },
    }),
  ];
  const members = buildRoster(entries, people);

  it("filters by exact team name", () => {
    expect(filterMembers(members, { team: "K-Pod", school: null }).map((m) => m.personId)).toEqual(["p3"]);
  });

  it("filters by normalized school, matching different casing and spacing", () => {
    const filtered = filterMembers(members, { team: null, school: normalizeSchool("Lakeside") });
    expect(filtered.map((m) => m.personId).sort()).toEqual(["p1", "p2"]);
  });

  it("applies no filter when both are null", () => {
    expect(filterMembers(members, { team: null, school: null })).toHaveLength(3);
  });
});

describe("teamOptions and schoolOptions", () => {
  const people: RawPerson[] = [
    { id: "p1", first_name: "Ada", last_name: "A", school: "Lakeside" },
    { id: "p2", first_name: "Bea", last_name: "B", school: "lakeside" },
    { id: "p3", first_name: "Cal", last_name: "C", school: null },
  ];
  const members = buildRoster(
    [
      entry({ id: "e1", registration_id: { participant_id: { person_id: "p1" } } }),
      entry({ id: "e2", registration_id: { participant_id: { person_id: "p2" } } }),
      entry({
        id: "e3",
        class_id: { id: "class-k", name: "K-Pod", program_id: { id: "prog-race", name: "Race Team" } },
        registration_id: { participant_id: { person_id: "p3" } },
      }),
    ],
    people,
  );

  it("lists each distinct team once, sorted", () => {
    expect(teamOptions(members).map((o) => o.value)).toEqual(["J-Pod", "K-Pod"]);
  });

  it("collapses schools that only differ by case or spacing into one option", () => {
    expect(schoolOptions(members)).toEqual([{ value: "lakeside", label: "Lakeside" }]);
  });
});

describe("familyIds", () => {
  it("includes a ward named by the viewer's own guardian links", () => {
    const links: RawGuardianLink[] = [{ subject_id: "child-1", contact_id: "me", relationship_type: "guardian" }];
    expect(familyIds(links, [])).toEqual(new Set(["child-1"]));
  });

  it("includes the viewer's own row from the self-filtered request", () => {
    const selfRows: RawPerson[] = [{ id: "self-1", first_name: "A", last_name: "A", share_contact: null }];
    expect(familyIds([], selfRows)).toEqual(new Set(["self-1"]));
  });

  it("ignores a link with no subject_id", () => {
    const links: RawGuardianLink[] = [{ subject_id: null, contact_id: "me", relationship_type: "guardian" }];
    expect(familyIds(links, [])).toEqual(new Set());
  });
});

describe("familyMembers and familyOptedIn", () => {
  it("pulls only the ids familyIds named out of the general people fetch", () => {
    const people: RawPerson[] = [
      { id: "child-1", first_name: "Kid", last_name: "One", share_contact: true },
      { id: "person-2", first_name: "B", last_name: "B", share_contact: null },
    ];
    expect(familyMembers(people, new Set(["child-1"])).map((p) => p.id)).toEqual(["child-1"]);
  });

  // Regression for #166 Finding 1: a Staff viewer's /items/people response carries a
  // `share_contact` key on every row once any policy on the role declares that field - masked to
  // `null`, not absent, wherever the `family` policy didn't actually grant it. Modeling that here
  // (every row present, most `null`) is the failure mode familyIds' explicit ids must not fall
  // back to guessing from.
  it("never mistakes a masked share_contact key for family membership", () => {
    const everyPersonInTheOrg: RawPerson[] = [
      { id: "person-1", first_name: "A", last_name: "A", share_contact: null },
      { id: "person-2", first_name: "B", last_name: "B", share_contact: null },
      { id: "person-3", first_name: "C", last_name: "C", share_contact: false },
    ];
    expect(familyMembers(everyPersonInTheOrg, familyIds([], []))).toEqual([]);
  });

  it("treats a permitted row with no answer yet as not opted in", () => {
    const people: RawPerson[] = [{ id: "p1", first_name: "A", last_name: "A", share_contact: null }];
    expect(familyOptedIn(familyMembers(people, new Set(["p1"])))).toBe(false);
  });

  it("is opted in when any family member is", () => {
    const people: RawPerson[] = [
      { id: "p1", first_name: "A", last_name: "A", share_contact: false },
      { id: "p2", first_name: "B", last_name: "B", share_contact: true },
    ];
    expect(familyOptedIn(familyMembers(people, new Set(["p1", "p2"])))).toBe(true);
  });
});

describe("guardianContactsByChild", () => {
  it("joins a guardian link to the guardian's own people row", () => {
    const people: RawPerson[] = [
      { id: "child-1", first_name: "Kid", last_name: "One" },
      { id: "guardian-1", first_name: "Gail", last_name: "Guardian", email: "g@example.com", phone: "555-0100" },
    ];
    const links: RawGuardianLink[] = [
      { subject_id: "child-1", contact_id: "guardian-1", relationship_type: "guardian" },
    ];
    expect(guardianContactsByChild(links, people).get("child-1")).toEqual([
      { personId: "guardian-1", fullName: "Gail Guardian", email: "g@example.com", phone: "555-0100" },
    ]);
  });

  it("ignores a non-guardian relationship and a link whose guardian row wasn't granted", () => {
    const people: RawPerson[] = [{ id: "child-1", first_name: "Kid", last_name: "One" }];
    const links: RawGuardianLink[] = [
      { subject_id: "child-1", contact_id: "missing", relationship_type: "guardian" },
      { subject_id: "child-1", contact_id: "child-1", relationship_type: "emergency_contact" },
    ];
    expect(guardianContactsByChild(links, people).size).toBe(0);
  });
});

describe("ACTIVE_CAMP_FILTER", () => {
  it("looks back 36 hours on end_date, covering Pacific's full last day (#166)", () => {
    expect(ACTIVE_CAMP_FILTER).toEqual({
      start_date: { _lte: "$NOW" },
      end_date: { _gte: "$NOW(-36 hours)" },
    });
  });
});
