import { describe, expect, it } from "vitest";
import { CampRow, ClassRow, RegistrationEntryRow, RegistrationRow } from "@cyc-seattle/clubspot";
import { ContactRow } from "@cyc-seattle/crm";
import { FamilyGroupTables, planFamilyGroupEmails } from "../src/family-group.js";
import { PersonWithLoginEmail } from "../src/schema.js";

const now = new Date("2026-07-15T00:00:00Z");

function camp(id: string, start: string | null, end: string | null): CampRow {
  return { id, name: id, start_date: start, end_date: end, archived: false, clubspot_sales_account: null };
}

function cls(id: string, campId: string): ClassRow {
  return { id, camp_id: campId, name: id, program_id: null };
}

function registration(id: string, participantId: string): RegistrationRow {
  return {
    id,
    participant_id: participantId,
    last_sync_run_id: null,
    camp_id: "unused",
    registered_at: "2026-01-01T00:00:00Z",
    status: "confirmed",
    waiver_status: null,
    archived: false,
  };
}

function entry(id: string, registrationId: string, classId: string, status: string): RegistrationEntryRow {
  return { id, registration_id: registrationId, session_id: "unused", class_id: classId, status };
}

function person(id: string, loginEmail: string | null): PersonWithLoginEmail {
  return {
    id,
    first_name: id,
    last_name: null,
    email: null,
    phone: null,
    date_of_birth: null,
    gender: null,
    street: null,
    city: null,
    state: null,
    postal_code: null,
    login_email: loginEmail,
  };
}

function contact(subjectId: string, contactId: string): ContactRow {
  return {
    subject_id: subjectId,
    contact_id: contactId,
    relationship_type: "guardian",
    contact_order: 1,
    relationship_detail: null,
  };
}

function baseTables(overrides: Partial<FamilyGroupTables> = {}): FamilyGroupTables {
  return {
    camps: [],
    classes: [],
    registrationEntries: [],
    registrations: [],
    participants: [],
    contacts: [],
    people: [],
    ...overrides,
  };
}

describe("planFamilyGroupEmails", () => {
  it("includes a current participant's own login email", () => {
    const tables = baseTables({
      camps: [camp("campA", "2026-07-01", "2026-07-31")],
      classes: [cls("classA", "campA")],
      registrations: [registration("reg1", "part1")],
      registrationEntries: [entry("entry1", "reg1", "classA", "confirmed")],
      participants: [{ id: "part1", person_id: "person1" }],
      people: [person("person1", "a@example.com")],
    });

    const { emails, skipped } = planFamilyGroupEmails(tables, now);

    expect(emails).toEqual(["a@example.com"]);
    expect(skipped).toBe(0);
  });

  it("excludes a participant whose camp has already ended", () => {
    const tables = baseTables({
      camps: [camp("campA", "2026-01-01", "2026-01-31")],
      classes: [cls("classA", "campA")],
      registrations: [registration("reg1", "part1")],
      registrationEntries: [entry("entry1", "reg1", "classA", "confirmed")],
      participants: [{ id: "part1", person_id: "person1" }],
      people: [person("person1", "a@example.com")],
    });

    const { emails } = planFamilyGroupEmails(tables, now);

    expect(emails).toEqual([]);
  });

  it("excludes a waitlisted entry", () => {
    const tables = baseTables({
      camps: [camp("campA", "2026-07-01", "2026-07-31")],
      classes: [cls("classA", "campA")],
      registrations: [registration("reg1", "part1")],
      registrationEntries: [entry("entry1", "reg1", "classA", "waitlist")],
      participants: [{ id: "part1", person_id: "person1" }],
      people: [person("person1", "a@example.com")],
    });

    const { emails } = planFamilyGroupEmails(tables, now);

    expect(emails).toEqual([]);
  });

  it("includes a current participant's guardian", () => {
    const tables = baseTables({
      camps: [camp("campA", "2026-07-01", "2026-07-31")],
      classes: [cls("classA", "campA")],
      registrations: [registration("reg1", "part1")],
      registrationEntries: [entry("entry1", "reg1", "classA", "confirmed")],
      participants: [{ id: "part1", person_id: "child1" }],
      contacts: [contact("child1", "guardian1")],
      people: [person("child1", "child@example.com"), person("guardian1", "guardian@example.com")],
    });

    const { emails } = planFamilyGroupEmails(tables, now);

    expect(emails).toEqual(["child@example.com", "guardian@example.com"]);
  });

  it("dedupes a shared family email across two current participants", () => {
    const tables = baseTables({
      camps: [camp("campA", "2026-07-01", "2026-07-31")],
      classes: [cls("classA", "campA")],
      registrations: [registration("reg1", "part1"), registration("reg2", "part2")],
      registrationEntries: [
        entry("entry1", "reg1", "classA", "confirmed"),
        entry("entry2", "reg2", "classA", "confirmed"),
      ],
      participants: [
        { id: "part1", person_id: "child1" },
        { id: "part2", person_id: "child2" },
      ],
      people: [person("child1", "family@example.com"), person("child2", "family@example.com")],
    });

    const { emails } = planFamilyGroupEmails(tables, now);

    expect(emails).toEqual(["family@example.com"]);
  });

  it("skips and counts a current participant with no resolvable person", () => {
    const tables = baseTables({
      camps: [camp("campA", "2026-07-01", "2026-07-31")],
      classes: [cls("classA", "campA")],
      registrations: [registration("reg1", "part1")],
      registrationEntries: [entry("entry1", "reg1", "classA", "confirmed")],
      participants: [{ id: "part1", person_id: null }],
      people: [],
    });

    const { emails, skipped } = planFamilyGroupEmails(tables, now);

    expect(emails).toEqual([]);
    expect(skipped).toBe(1);
  });

  it("skips and counts a current participant with no usable login email", () => {
    const tables = baseTables({
      camps: [camp("campA", "2026-07-01", "2026-07-31")],
      classes: [cls("classA", "campA")],
      registrations: [registration("reg1", "part1")],
      registrationEntries: [entry("entry1", "reg1", "classA", "confirmed")],
      participants: [{ id: "part1", person_id: "person1" }],
      people: [person("person1", null)],
    });

    const { emails, skipped } = planFamilyGroupEmails(tables, now);

    expect(emails).toEqual([]);
    expect(skipped).toBe(1);
  });
});
