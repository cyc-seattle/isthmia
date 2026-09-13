import { describe, it, expect } from "vitest";
import type { Participant } from "@cyc-seattle/clubspot-sdk";
import {
  buildEmergencyContactRow,
  buildGuardianContactRow,
  buildMedicalProfileFields,
  buildPersonFieldsFromParticipant,
  ContactRow,
  emergencyContactInputsFromParticipant,
  fillGapsPatch,
  guardianInputsFromParticipant,
  isWithinEditDistanceOne,
  matchEmergencyContact,
  matchGuardian,
  matchParticipant,
  needsNewContact,
  normalizeEmail,
  normalizeName,
  normalizePhone,
  parseWeight,
  PersonRow,
  personFieldsFromEmergencyContact,
  personFieldsFromGuardian,
  splitContactName,
} from "../src/people.js";

// Minimal Parse.Object stand-in: just an id and a `.get(key)` accessor, per roster.test.ts.
function parseObject(id: string, data: Record<string, unknown>) {
  return { id, get: (key: string) => data[key] };
}

function participant(data: Record<string, unknown>) {
  return parseObject("participant-1", data) as unknown as Participant;
}

function person(overrides: Partial<PersonRow> & { id: string }): PersonRow {
  return {
    first_name: "",
    last_name: null,
    email: null,
    phone: null,
    date_of_birth: null,
    gender: null,
    street: null,
    city: null,
    state: null,
    postal_code: null,
    ...overrides,
  };
}

describe("normalization", () => {
  it("normalizeName trims, lowercases, collapses whitespace, and strips punctuation", () => {
    expect(normalizeName("  Mary-Jane   O'Brien ")).toBe("mary jane o brien");
  });

  it("normalizeName treats null and empty as no value", () => {
    expect(normalizeName(null)).toBeNull();
    expect(normalizeName("   ")).toBeNull();
  });

  it("normalizeEmail trims and lowercases", () => {
    expect(normalizeEmail(" Jane.Doe@Example.com ")).toBe("jane.doe@example.com");
  });

  it("normalizePhone keeps only digits", () => {
    expect(normalizePhone("(206) 555-0113")).toBe("2065550113");
  });
});

describe("isWithinEditDistanceOne", () => {
  it("matches a one-character typo", () => {
    expect(isWithinEditDistanceOne("jon", "john")).toBe(true);
  });

  it("matches an exact string", () => {
    expect(isWithinEditDistanceOne("jane", "jane")).toBe(true);
  });

  it("does not match Bob against Robert", () => {
    expect(isWithinEditDistanceOne("bob", "robert")).toBe(false);
  });
});

describe("splitContactName", () => {
  it("splits on the first space", () => {
    expect(splitContactName("Jane Marie Doe")).toEqual({ firstName: "Jane", lastName: "Marie Doe" });
  });

  // first_name isn't nullable, so a single token has to become the first name.
  it("puts a single token in first_name and leaves last_name null", () => {
    expect(splitContactName("Cher")).toEqual({ firstName: "Cher", lastName: null });
  });
});

describe("matchParticipant", () => {
  const candidates: PersonRow[] = [
    person({ id: "p1", first_name: "Alex", last_name: "Rivera", date_of_birth: "2015-04-01" }),
  ];

  it("matches on same name and date of birth", () => {
    const match = matchParticipant(candidates, {
      firstName: "alex",
      lastName: "rivera",
      dateOfBirth: "2015-04-01",
      email: null,
    });
    expect(match?.id).toBe("p1");
  });

  it("does not match a different date of birth", () => {
    const match = matchParticipant(candidates, {
      firstName: "alex",
      lastName: "rivera",
      dateOfBirth: "2016-04-01",
      email: null,
    });
    expect(match).toBeUndefined();
  });

  it("without a date of birth, requires the same email too", () => {
    const noDob: PersonRow[] = [
      person({ id: "p2", first_name: "Alex", last_name: "Rivera", email: "alex@example.com" }),
    ];

    expect(
      matchParticipant(noDob, { firstName: "Alex", lastName: "Rivera", dateOfBirth: null, email: null }),
    ).toBeUndefined();
    expect(
      matchParticipant(noDob, { firstName: "Alex", lastName: "Rivera", dateOfBirth: null, email: "alex@example.com" })
        ?.id,
    ).toBe("p2");
  });
});

describe("matchGuardian", () => {
  const candidate = person({ id: "g1", first_name: "Robert", last_name: "Smith", email: "family@example.com" });

  it("matches on same email, last name, and a first-name typo", () => {
    const match = matchGuardian([candidate], { firstName: "Robert", lastName: "Smith", email: "family@example.com" });
    expect(match?.id).toBe("g1");
  });

  it("allows one edit on the first name", () => {
    const typo = person({ id: "g2", first_name: "Jon", last_name: "Smith", email: "family@example.com" });
    const match = matchGuardian([typo], { firstName: "John", lastName: "Smith", email: "family@example.com" });
    expect(match?.id).toBe("g2");
  });

  it("does not match Bob against Robert", () => {
    const match = matchGuardian([candidate], { firstName: "Bob", lastName: "Smith", email: "family@example.com" });
    expect(match).toBeUndefined();
  });

  // Families share one email address across different adults - email alone must never match.
  it("does not merge two different guardians who share a family email", () => {
    const dad = person({ id: "g1", first_name: "Robert", last_name: "Smith", email: "family@example.com" });
    const match = matchGuardian([dad], { firstName: "Susan", lastName: "Jones", email: "family@example.com" });
    expect(match).toBeUndefined();
  });

  it("requires an email on the input", () => {
    expect(matchGuardian([candidate], { firstName: "Robert", lastName: "Smith", email: null })).toBeUndefined();
  });
});

describe("matchEmergencyContact", () => {
  it("matches on full name and phone", () => {
    const candidate = person({ id: "e1", first_name: "Pat", last_name: "Nguyen", phone: "2065550100" });
    const match = matchEmergencyContact([candidate], { fullName: "Pat Nguyen", phone: "(206) 555-0100", email: null });
    expect(match?.id).toBe("e1");
  });

  it("does not match on name alone without a phone or email", () => {
    const candidate = person({ id: "e1", first_name: "Pat", last_name: "Nguyen", phone: "2065550100" });
    const match = matchEmergencyContact([candidate], { fullName: "Pat Nguyen", phone: null, email: null });
    expect(match).toBeUndefined();
  });

  it("matches on emergencyEmail when present", () => {
    const candidate = person({
      id: "e1",
      first_name: "Pat",
      last_name: "Nguyen",
      email: "pat@example.com",
      phone: null,
    });
    const match = matchEmergencyContact([candidate], { fullName: "Pat Nguyen", phone: null, email: "pat@example.com" });
    expect(match?.id).toBe("e1");
  });
});

describe("fillGapsPatch", () => {
  it("fills a null field and leaves an existing value untouched", () => {
    const existing = person({ id: "p1", first_name: "Alex", last_name: "Rivera", email: null, phone: "2065550100" });
    const patch = fillGapsPatch(existing, { email: "alex@example.com", phone: "9999999999" });
    expect(patch).toEqual({ email: "alex@example.com" });
  });

  it("produces no patch when everything already has a value", () => {
    const existing = person({ id: "p1", first_name: "Alex", email: "alex@example.com" });
    expect(fillGapsPatch(existing, { email: "new@example.com" })).toEqual({});
  });
});

describe("parseWeight", () => {
  it("parses a numeric string", () => {
    expect(parseWeight("105")).toBe(105);
  });

  it("drops a value below the plausibility floor instead of storing it", () => {
    expect(parseWeight("1")).toBeNull();
  });

  it("drops a non-numeric value", () => {
    expect(parseWeight("abc")).toBeNull();
  });

  it("treats a missing value as null", () => {
    expect(parseWeight(undefined)).toBeNull();
  });
});

describe("buildPersonFieldsFromParticipant", () => {
  it("maps the participant's own fields", () => {
    const fields = buildPersonFieldsFromParticipant(
      participant({
        firstName: "Alex",
        lastName: "Rivera",
        email: "alex@example.com",
        mobile: "2065550100",
        DOB: new Date("2015-04-01T00:00:00Z"),
        gender: "F",
        street: "123 Main St",
        city: "Seattle",
        state: "WA",
        zip: "98101",
      }),
    );

    expect(fields).toEqual({
      first_name: "Alex",
      last_name: "Rivera",
      email: "alex@example.com",
      phone: "2065550100",
      date_of_birth: "2015-04-01",
      gender: "F",
      street: "123 Main St",
      city: "Seattle",
      state: "WA",
      postal_code: "98101",
    });
  });
});

describe("guardianInputsFromParticipant", () => {
  it("gives the primary and secondary guardian distinct contact orders", () => {
    const inputs = guardianInputsFromParticipant(
      participant({
        parentGuardianName: "Robert Smith",
        parentGuardianEmail: "robert@example.com",
        parentGuardianMobile: "2065550100",
        parentGuardianName_secondary: "Susan Smith",
        parentGuardianEmail_secondary: "susan@example.com",
      }),
    );

    expect(inputs).toEqual([
      { fullName: "Robert Smith", email: "robert@example.com", mobile: "2065550100", contactOrder: 1 },
      { fullName: "Susan Smith", email: "susan@example.com", mobile: null, contactOrder: 2 },
    ]);
  });

  it("omits a guardian with no name", () => {
    expect(guardianInputsFromParticipant(participant({}))).toEqual([]);
  });
});

describe("emergencyContactInputsFromParticipant", () => {
  it("gives the primary and secondary emergency contact distinct contact orders", () => {
    const inputs = emergencyContactInputsFromParticipant(
      participant({
        emergencyContact: "Pat Nguyen",
        emergencyMobile: "2065550100",
        emergencyRelationship: "Aunt",
        emergencyContact_secondary: "Sam Nguyen",
        emergencyMobile_secondary: "2065550199",
      }),
    );

    expect(inputs).toEqual([
      { fullName: "Pat Nguyen", phone: "2065550100", email: null, relationshipDetail: "Aunt", contactOrder: 1 },
      { fullName: "Sam Nguyen", phone: "2065550199", email: null, relationshipDetail: null, contactOrder: 2 },
    ]);
  });
});

describe("personFieldsFromGuardian and personFieldsFromEmergencyContact", () => {
  it("splits the free-text name", () => {
    const fields = personFieldsFromGuardian({
      fullName: "Robert Smith",
      email: "robert@example.com",
      mobile: "2065550100",
      contactOrder: 1,
    });
    expect(fields.first_name).toBe("Robert");
    expect(fields.last_name).toBe("Smith");
  });

  it("carries the emergency contact's phone rather than a guardian's mobile", () => {
    const fields = personFieldsFromEmergencyContact({
      fullName: "Pat Nguyen",
      phone: "2065550100",
      email: null,
      relationshipDetail: "Aunt",
      contactOrder: 1,
    });
    expect(fields).toMatchObject({ first_name: "Pat", last_name: "Nguyen", phone: "2065550100" });
  });
});

describe("buildGuardianContactRow and buildEmergencyContactRow", () => {
  it("build distinct relationship types", () => {
    expect(buildGuardianContactRow("minor-1", "guardian-1", 1)).toMatchObject({
      relationship_type: "guardian",
      contact_order: 1,
    });
    expect(buildEmergencyContactRow("minor-1", "contact-1", 2, "Aunt")).toMatchObject({
      relationship_type: "emergency_contact",
      contact_order: 2,
      relationship_detail: "Aunt",
    });
  });
});

describe("needsNewContact", () => {
  it("is true when no row exists for that order", () => {
    expect(needsNewContact([], 1)).toBe(true);
  });

  // This is the pure half of the merge-durability regression test: once a contacts row exists
  // for an order, the executor must not even attempt to re-match it.
  it("is false once a contacts row exists for that order, regardless of who the matcher would now pick", () => {
    const existing: ContactRow[] = [
      {
        id: "contact-1",
        related_person_id: "minor-1",
        person_id: "person-A",
        relationship_type: "guardian",
        contact_order: 1,
        relationship_detail: null,
      },
    ];
    expect(needsNewContact(existing, 1)).toBe(false);

    const wouldMatchInstead = matchGuardian(
      [person({ id: "person-B", first_name: "Robert", last_name: "Smith", email: "family@example.com" })],
      { firstName: "Robert", lastName: "Smith", email: "family@example.com" },
    );
    expect(wouldMatchInstead?.id).toBe("person-B");
  });
});

describe("buildMedicalProfileFields", () => {
  it("maps medical fields and parses weight", () => {
    const fields = buildMedicalProfileFields(
      participant({
        medical: "Asthma",
        medical_allergies: "Peanuts",
        medical_meds: "Inhaler",
        medical_tetanus: "2023-01-01",
        pcpName: "Dr. Lee",
        pcpNumber: "2065550188",
        weight: "105",
      }),
    );

    expect(fields).toEqual({
      conditions: "Asthma",
      allergies: "Peanuts",
      medications: "Inhaler",
      last_tetanus: "2023-01-01",
      physician_name: "Dr. Lee",
      physician_phone: "2065550188",
      weight: 105,
    });
  });

  it("drops an unparseable weight rather than storing it", () => {
    const fields = buildMedicalProfileFields(participant({ weight: "1" }));
    expect(fields.weight).toBeNull();
  });
});
