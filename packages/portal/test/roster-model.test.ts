import { describe, it, expect } from "vitest";
import {
  buildRoster,
  familyMembers,
  familyOptedIn,
  filterMembers,
  groupByProgram,
  normalizeSchool,
  schoolOptions,
  teamOptions,
  type RawEntry,
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

describe("familyMembers and familyOptedIn", () => {
  it("keeps only rows where Directus returned the share_contact key", () => {
    const people: RawPerson[] = [
      { id: "p1", first_name: "A", last_name: "A", share_contact: false },
      { id: "p2", first_name: "B", last_name: "B" },
    ];
    expect(familyMembers(people).map((p) => p.id)).toEqual(["p1"]);
  });

  it("treats a permitted row with no answer yet as not opted in", () => {
    const people: RawPerson[] = [{ id: "p1", first_name: "A", last_name: "A", share_contact: null }];
    expect(familyOptedIn(familyMembers(people))).toBe(false);
  });

  it("is opted in when any family member is", () => {
    const people: RawPerson[] = [
      { id: "p1", first_name: "A", last_name: "A", share_contact: false },
      { id: "p2", first_name: "B", last_name: "B", share_contact: true },
    ];
    expect(familyOptedIn(familyMembers(people))).toBe(true);
  });
});
