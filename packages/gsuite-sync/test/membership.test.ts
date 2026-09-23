import { describe, expect, it } from "vitest";
import { ContactRow, PersonRow, RegistrationEntryRow, RegistrationRow } from "@cyc-seattle/crm";
import { MembershipTables, planClassMembers } from "../src/membership.js";

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
    offering_id: "offering-1",
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

const CLASS_ID = "class-1";

function tables(overrides: Partial<MembershipTables>): MembershipTables {
  return {
    registrationEntries: [],
    registrations: [],
    people: [],
    contacts: [],
    ...overrides,
  };
}

describe("planClassMembers", () => {
  it("includes a guardian and excludes an emergency contact", () => {
    const result = planClassMembers(
      CLASS_ID,
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
    );

    expect(result).toEqual(["guardian@example.com"]);
  });

  it("includes an adult participant's own email with no guardian row", () => {
    const result = planClassMembers(
      CLASS_ID,
      tables({
        registrationEntries: [entry("e1", "r1", CLASS_ID, "confirmed")],
        registrations: [registration("r1", "adult")],
        people: [person("adult", "adult@example.com")],
        contacts: [],
      }),
    );

    expect(result).toEqual(["adult@example.com"]);
  });

  it("dedupes an email shared by a participant and their guardian", () => {
    const result = planClassMembers(
      CLASS_ID,
      tables({
        registrationEntries: [entry("e1", "r1", CLASS_ID, "confirmed")],
        registrations: [registration("r1", "participant")],
        people: [person("participant", "family@example.com"), person("guardian", "  Family@Example.com ")],
        contacts: [contact("c1", "participant", "guardian", "guardian")],
      }),
    );

    expect(result).toEqual(["family@example.com"]);
  });

  it("excludes a registration entry that isn't confirmed", () => {
    const result = planClassMembers(
      CLASS_ID,
      tables({
        registrationEntries: [entry("e1", "r1", CLASS_ID, "waitlist")],
        registrations: [registration("r1", "participant")],
        people: [person("participant", "waitlisted@example.com")],
        contacts: [],
      }),
    );

    expect(result).toEqual([]);
  });

  it("ignores a confirmed entry for a different class", () => {
    const result = planClassMembers(
      CLASS_ID,
      tables({
        registrationEntries: [entry("e1", "r1", "other-class", "confirmed")],
        registrations: [registration("r1", "participant")],
        people: [person("participant", "elsewhere@example.com")],
        contacts: [],
      }),
    );

    expect(result).toEqual([]);
  });
});
