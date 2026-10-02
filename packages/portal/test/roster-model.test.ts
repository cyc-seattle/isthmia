import { describe, it, expect } from "vitest";
import {
  ACTIVE_CAMP_FILTER,
  buildRoster,
  FAMILY_REGISTRATIONS_FILTER,
  filterMembers,
  groupByProgram,
  guardianContactsByChild,
  normalizeSchool,
  schoolOptions,
  shareToggleRows,
  teamOptions,
  VIEWER_SELF_FILTER,
  type RawEntry,
  type RawGuardianLink,
  type RawParticipant,
  type RawPerson,
  type RawRegistration,
} from "../src/roster/model.js";

function entry(overrides: Partial<RawEntry> = {}): RawEntry {
  return {
    id: "entry-1",
    class_id: { id: "class-j", name: "J-Pod", program_id: { id: "prog-race", name: "Race Team" } },
    registration_id: { id: "reg-1", participant_id: { person_id: "person-1" } },
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
    expect(buildRoster([entry({ registration_id: { id: "reg-1", participant_id: null } })], people)).toEqual([]);
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
        registration_id: { id: "reg-p2", participant_id: { person_id: "p2" } },
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
    entry({ id: "e1", registration_id: { id: "reg-p1", participant_id: { person_id: "p1" } } }),
    entry({ id: "e2", registration_id: { id: "reg-p2", participant_id: { person_id: "p2" } } }),
    entry({
      id: "e3",
      class_id: { id: "class-k", name: "K-Pod", program_id: { id: "prog-race", name: "Race Team" } },
      registration_id: { id: "reg-p3", participant_id: { person_id: "p3" } },
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
      entry({ id: "e1", registration_id: { id: "reg-p1", participant_id: { person_id: "p1" } } }),
      entry({ id: "e2", registration_id: { id: "reg-p2", participant_id: { person_id: "p2" } } }),
      entry({
        id: "e3",
        class_id: { id: "class-k", name: "K-Pod", program_id: { id: "prog-race", name: "Race Team" } },
        registration_id: { id: "reg-p3", participant_id: { person_id: "p3" } },
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

describe("FAMILY_REGISTRATIONS_FILTER", () => {
  it("carries the active-camp clause, the $CURRENT_USER.email match, and the guardian branch through my_contacts", () => {
    expect(FAMILY_REGISTRATIONS_FILTER).toEqual({
      _and: [
        { camp_id: ACTIVE_CAMP_FILTER },
        {
          participant_id: {
            person_id: {
              _or: [
                {
                  my_contacts: {
                    _and: [
                      { relationship_type: { _eq: "guardian" } },
                      { contact_id: { email: { _eq: "$CURRENT_USER.email" } } },
                    ],
                  },
                },
                {
                  _and: [{ email: { _eq: "$CURRENT_USER.email" } }, { date_of_birth: { _lte: "$NOW(-18 years)" } }],
                },
              ],
            },
          },
        },
      ],
    });
  });
});

describe("VIEWER_SELF_FILTER", () => {
  it("matches the signed-in user's own adult row", () => {
    expect(VIEWER_SELF_FILTER).toEqual({
      _and: [{ email: { _eq: "$CURRENT_USER.email" } }, { date_of_birth: { _lte: "$NOW(-18 years)" } }],
    });
  });
});

describe("shareToggleRows", () => {
  const participants: RawParticipant[] = [{ id: "participant-1", person_id: "person-1" }];
  const people: RawPerson[] = [{ id: "person-1", first_name: "Ada", last_name: "Lovelace" }];

  function registration(overrides: Partial<RawRegistration> = {}): RawRegistration {
    return { id: "reg-1", camp_id: "camp-1", participant_id: "participant-1", share_contact: null, ...overrides };
  }

  function entryFor(registrationId: string, overrides: Partial<RawEntry> = {}): RawEntry {
    return {
      id: `entry-${registrationId}`,
      class_id: { id: "class-j", name: "J-Pod", program_id: { id: "prog-race", name: "Race Team" } },
      registration_id: { id: registrationId, participant_id: { person_id: null } },
      ...overrides,
    };
  }

  it("builds a row for a writable registration, labeled with the first name and program name", () => {
    const [row] = shareToggleRows([registration()], participants, people, [entryFor("reg-1")], null);
    expect(row).toMatchObject({
      personId: "person-1",
      programId: "prog-race",
      programName: "Race Team",
      firstName: "Ada",
      checked: false,
      registrationIds: ["reg-1"],
    });
  });

  it("checks the row when share_contact is true", () => {
    const [row] = shareToggleRows(
      [registration({ share_contact: true })],
      participants,
      people,
      [entryFor("reg-1")],
      null,
    );
    expect(row?.checked).toBe(true);
  });

  it("drops a registration with a null camp_id", () => {
    expect(shareToggleRows([registration({ camp_id: null })], participants, people, [entryFor("reg-1")], null)).toEqual(
      [],
    );
  });

  it("drops a registration whose participant or person can't be resolved", () => {
    expect(
      shareToggleRows([registration({ participant_id: "missing" })], participants, people, [entryFor("reg-1")], null),
    ).toEqual([]);
    expect(shareToggleRows([registration()], participants, [], [entryFor("reg-1")], null)).toEqual([]);
  });

  it("drops a registration with no program through the entries chain", () => {
    expect(shareToggleRows([registration()], participants, people, [], null)).toEqual([]);
  });

  it("falls back to placeholder text when the first name is blank", () => {
    const [row] = shareToggleRows(
      [registration()],
      participants,
      [{ id: "person-1", first_name: null, last_name: null }],
      [entryFor("reg-1")],
      null,
    );
    expect(row).toMatchObject({ firstName: "(name withheld)" });
  });

  it("collapses two registrations in the same program into one row, checked if either opted in", () => {
    const registrations = [
      registration({ id: "reg-1", share_contact: null }),
      registration({ id: "reg-2", camp_id: "camp-2", share_contact: true }),
    ];
    const [row] = shareToggleRows(registrations, participants, people, [entryFor("reg-1"), entryFor("reg-2")], null);
    expect(row).toMatchObject({ personId: "person-1", programId: "prog-race", checked: true });
    expect([...(row?.registrationIds ?? [])].sort()).toEqual(["reg-1", "reg-2"]);
  });

  it("marks the viewer's own row isSelf, and a child's row not", () => {
    const allParticipants: RawParticipant[] = [
      { id: "participant-1", person_id: "person-1" },
      { id: "participant-2", person_id: "person-2" },
    ];
    const allPeople: RawPerson[] = [
      { id: "person-1", first_name: "Ada", last_name: "Lovelace" },
      { id: "person-2", first_name: "Kid", last_name: "One" },
    ];
    const registrations = [
      registration({ id: "reg-1", participant_id: "participant-1" }),
      registration({ id: "reg-2", participant_id: "participant-2" }),
    ];
    const entries = [entryFor("reg-1"), entryFor("reg-2")];
    const rows = shareToggleRows(registrations, allParticipants, allPeople, entries, "person-1");
    expect(rows.find((row) => row.personId === "person-1")?.isSelf).toBe(true);
    expect(rows.find((row) => row.personId === "person-2")?.isSelf).toBe(false);
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
