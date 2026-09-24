import { describe, expect, it } from "vitest";
import { ContactRow, PersonRow, ProgramRoleAssignmentRow } from "@cyc-seattle/crm";
import { CampRow, ClassRow, RegistrationEntryRow, RegistrationRow } from "@cyc-seattle/clubspot";
import { isCurrentProgramRole, isValidEmail, MembershipTables, planProgramMembers } from "../src/membership.js";

const now = new Date("2026-06-15T00:00:00Z");

function person(id: string, email: string | null): PersonRow {
  return {
    id,
    first_name: id,
    last_name: null,
    email,
    phone: null,
    date_of_birth: null,
    gender: null,
    street: null,
    city: null,
    state: null,
    postal_code: null,
  };
}

function registration(id: string, personId: string): RegistrationRow {
  return {
    id,
    person_id: personId,
    camp_id: "camp-1",
    registered_at: "2026-01-01T00:00:00Z",
    status: "confirmed",
    waiver_status: null,
    archived: false,
  };
}

function entry(id: string, registrationId: string, classId: string, status: string): RegistrationEntryRow {
  return {
    id,
    registration_id: registrationId,
    session_id: "session-1",
    class_id: classId,
    status,
  };
}

function contact(
  id: string,
  subjectId: string,
  contactId: string,
  relationshipType: ContactRow["relationship_type"],
): ContactRow {
  return {
    id,
    subject_id: subjectId,
    contact_id: contactId,
    relationship_type: relationshipType,
    contact_order: 1,
    relationship_detail: null,
  };
}

function cls(id: string, programId: string | null): ClassRow {
  return { id, camp_id: "camp-1", name: id, program_id: programId };
}

function camp(id: string, endDate: string | null): CampRow {
  return { id, name: id, start_date: null, end_date: endDate, clubspot_sales_account: null };
}

function roleAssignment(overrides: Partial<ProgramRoleAssignmentRow>): ProgramRoleAssignmentRow {
  return {
    id: "assignment-1",
    person_id: "person-1",
    program_id: "program-1",
    program_role_id: "role-1",
    starts_on: null,
    ends_on: null,
    ...overrides,
  };
}

const PROGRAM_ID = "program-1";
const CLASS_ID = "class-1";

function tables(overrides: Partial<MembershipTables>): MembershipTables {
  return {
    classes: [cls(CLASS_ID, PROGRAM_ID)],
    camps: [camp("camp-1", null)],
    registrationEntries: [],
    registrations: [],
    people: [],
    contacts: [],
    programRoleAssignments: [],
    ...overrides,
  };
}

describe("isCurrentProgramRole", () => {
  it("is true with no starts_on or ends_on", () => {
    expect(isCurrentProgramRole({ starts_on: null, ends_on: null }, now)).toBe(true);
  });

  it("is false when starts_on is in the future", () => {
    expect(isCurrentProgramRole({ starts_on: "2026-08-01T00:00:00Z", ends_on: null }, now)).toBe(false);
  });

  it("is false when ends_on is in the past", () => {
    expect(isCurrentProgramRole({ starts_on: null, ends_on: "2026-01-01T00:00:00Z" }, now)).toBe(false);
  });

  it("is true when now is within the window", () => {
    expect(isCurrentProgramRole({ starts_on: "2026-01-01T00:00:00Z", ends_on: "2026-08-01T00:00:00Z" }, now)).toBe(
      true,
    );
  });
});

describe("planProgramMembers", () => {
  it("skips an unusable guardian email and keeps everyone else", () => {
    const result = planProgramMembers(
      PROGRAM_ID,
      tables({
        registrationEntries: [entry("e1", "r1", CLASS_ID, "confirmed")],
        registrations: [registration("r1", "participant")],
        people: [
          person("participant", "participant@example.com"),
          person("guardian", "206-965-5407"),
          person("other-guardian", "aimeekimball.gmail.com"),
        ],
        contacts: [
          contact("c1", "participant", "guardian", "guardian"),
          contact("c2", "participant", "other-guardian", "guardian"),
        ],
      }),
      now,
    );

    expect(result).toEqual(["participant@example.com"]);
  });

  it("includes a guardian and excludes an emergency contact", () => {
    const result = planProgramMembers(
      PROGRAM_ID,
      tables({
        registrationEntries: [entry("e1", "r1", CLASS_ID, "confirmed")],
        registrations: [registration("r1", "participant")],
        people: [
          person("participant", null),
          person("guardian", "guardian@example.com"),
          person("emergency", "emergency@example.com"),
        ],
        contacts: [
          contact("c1", "participant", "guardian", "guardian"),
          contact("c2", "participant", "emergency", "emergency_contact"),
        ],
      }),
      now,
    );

    expect(result).toEqual(["guardian@example.com"]);
  });

  it("includes an adult participant's own email with no guardian row", () => {
    const result = planProgramMembers(
      PROGRAM_ID,
      tables({
        registrationEntries: [entry("e1", "r1", CLASS_ID, "confirmed")],
        registrations: [registration("r1", "adult")],
        people: [person("adult", "adult@example.com")],
        contacts: [],
      }),
      now,
    );

    expect(result).toEqual(["adult@example.com"]);
  });

  it("dedupes an email shared by a participant and their guardian", () => {
    const result = planProgramMembers(
      PROGRAM_ID,
      tables({
        registrationEntries: [entry("e1", "r1", CLASS_ID, "confirmed")],
        registrations: [registration("r1", "participant")],
        people: [person("participant", "family@example.com"), person("guardian", "  Family@Example.com ")],
        contacts: [contact("c1", "participant", "guardian", "guardian")],
      }),
      now,
    );

    expect(result).toEqual(["family@example.com"]);
  });

  it("excludes a registration entry that isn't confirmed", () => {
    const result = planProgramMembers(
      PROGRAM_ID,
      tables({
        registrationEntries: [entry("e1", "r1", CLASS_ID, "waitlist")],
        registrations: [registration("r1", "participant")],
        people: [person("participant", "waitlisted@example.com")],
        contacts: [],
      }),
      now,
    );

    expect(result).toEqual([]);
  });

  it("ignores a confirmed entry for a class outside the program", () => {
    const result = planProgramMembers(
      PROGRAM_ID,
      tables({
        classes: [cls(CLASS_ID, PROGRAM_ID), cls("other-class", "other-program")],
        registrationEntries: [entry("e1", "r1", "other-class", "confirmed")],
        registrations: [registration("r1", "participant")],
        people: [person("participant", "elsewhere@example.com")],
        contacts: [],
      }),
      now,
    );

    expect(result).toEqual([]);
  });

  it("reaches a participant through program -> classes -> registration_entries", () => {
    const result = planProgramMembers(
      PROGRAM_ID,
      tables({
        classes: [cls("j-pod", PROGRAM_ID), cls("k-pod", PROGRAM_ID)],
        registrationEntries: [entry("e1", "r1", "k-pod", "confirmed")],
        registrations: [registration("r1", "participant")],
        people: [person("participant", "participant@example.com")],
        contacts: [],
      }),
      now,
    );

    expect(result).toEqual(["participant@example.com"]);
  });

  it("includes a person holding a current program_role_assignments row", () => {
    const result = planProgramMembers(
      PROGRAM_ID,
      tables({
        people: [person("coordinator", "coordinator@example.com")],
        programRoleAssignments: [roleAssignment({ person_id: "coordinator", program_id: PROGRAM_ID })],
      }),
      now,
    );

    expect(result).toEqual(["coordinator@example.com"]);
  });

  it("excludes a program_role_assignments row outside its starts_on/ends_on window", () => {
    const result = planProgramMembers(
      PROGRAM_ID,
      tables({
        people: [person("coordinator", "coordinator@example.com")],
        programRoleAssignments: [
          roleAssignment({
            person_id: "coordinator",
            program_id: PROGRAM_ID,
            starts_on: "2026-08-01T00:00:00Z",
          }),
        ],
      }),
      now,
    );

    expect(result).toEqual([]);
  });

  it("excludes a program_role_assignments row for a different program", () => {
    const result = planProgramMembers(
      PROGRAM_ID,
      tables({
        people: [person("coordinator", "coordinator@example.com")],
        programRoleAssignments: [roleAssignment({ person_id: "coordinator", program_id: "other-program" })],
      }),
      now,
    );

    expect(result).toEqual([]);
  });

  it("includes a role holder even when the program has no class at all", () => {
    // The step 8-13 collapse regressed this: a program whose only activity is a role assignment -
    // off-season, or set up before its first class exists - must still get its role holder (#149).
    const result = planProgramMembers(
      PROGRAM_ID,
      tables({
        classes: [],
        camps: [],
        people: [person("coordinator", "coordinator@example.com")],
        programRoleAssignments: [roleAssignment({ person_id: "coordinator", program_id: PROGRAM_ID })],
      }),
      now,
    );

    expect(result).toEqual(["coordinator@example.com"]);
  });

  it("excludes a participant whose class's camp ended more than ~12 months ago", () => {
    const result = planProgramMembers(
      PROGRAM_ID,
      tables({
        camps: [camp("camp-1", "2025-01-01T00:00:00Z")],
        registrationEntries: [entry("e1", "r1", CLASS_ID, "confirmed")],
        registrations: [registration("r1", "participant")],
        people: [person("participant", "participant@example.com")],
      }),
      now,
    );

    expect(result).toEqual([]);
  });

  it("includes a participant whose class's camp ended recently, within the membership window", () => {
    const result = planProgramMembers(
      PROGRAM_ID,
      tables({
        camps: [camp("camp-1", "2026-03-01T00:00:00Z")],
        registrationEntries: [entry("e1", "r1", CLASS_ID, "confirmed")],
        registrations: [registration("r1", "participant")],
        people: [person("participant", "participant@example.com")],
      }),
      now,
    );

    expect(result).toEqual(["participant@example.com"]);
  });

  it("ignores the camp window entirely when ignoreCampWindow is set", () => {
    const result = planProgramMembers(
      PROGRAM_ID,
      tables({
        camps: [camp("camp-1", "2020-01-01T00:00:00Z")],
        registrationEntries: [entry("e1", "r1", CLASS_ID, "confirmed")],
        registrations: [registration("r1", "participant")],
        people: [person("participant", "participant@example.com")],
      }),
      now,
      { ignoreCampWindow: true },
    );

    expect(result).toEqual(["participant@example.com"]);
  });
});

describe("isValidEmail", () => {
  it.each(["a@example.com", " Planned@Example.com ", "first.last+tag@sub.example.org"])("accepts %s", (email) => {
    expect(isValidEmail(email)).toBe(true);
  });

  it.each(["206-965-5407", "Bauer", "the foghorns@gmail.com", "375784022qq.com", "a..b@example.com", "N/A"])(
    "rejects %s",
    (email) => {
      expect(isValidEmail(email)).toBe(false);
    },
  );
});
