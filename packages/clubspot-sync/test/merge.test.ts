import { describe, it, expect } from "vitest";
import {
  findDuplicatePeople,
  planPersonMerge,
  MergeContact,
  MergeContactPoint,
  MergeMedicalProfile,
  MergePerson,
  MergePersonReference,
  MergeRelatedData,
} from "../src/merge.js";

function person(overrides: Partial<MergePerson> & { id: string }): MergePerson {
  return {
    first_name: "Jane",
    last_name: "Doe",
    email: null,
    phone: null,
    date_of_birth: null,
    gender: null,
    street: null,
    city: null,
    state: null,
    postal_code: null,
    school: null,
    directus_user_id: null,
    ...overrides,
  };
}

function related(overrides: Partial<MergeRelatedData> = {}): MergeRelatedData {
  return {
    participants: [],
    medicalProfiles: [],
    contacts: [],
    contactPoints: [],
    programRoleAssignments: [],
    eventStaff: [],
    ...overrides,
  };
}

describe("findDuplicatePeople", () => {
  it("groups people sharing a normalized first and last name", () => {
    const people = [
      person({ id: "1", first_name: "Jane", last_name: "Doe" }),
      person({ id: "2", first_name: "  jane", last_name: "DOE " }),
      person({ id: "3", first_name: "John", last_name: "Smith" }),
    ];
    const groups = findDuplicatePeople(people, new Map());
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("groups people with no last name the same way as any other name", () => {
    const people = [
      person({ id: "1", first_name: "Cher", last_name: null }),
      person({ id: "2", first_name: "Cher", last_name: null }),
    ];
    const groups = findDuplicatePeople(people, new Map());
    expect(groups).toHaveLength(1);
  });

  it("returns each member's id and date of birth, not email or phone", () => {
    const people = [
      person({ id: "1", date_of_birth: "2010-01-01", email: "a@example.com" }),
      person({ id: "2", date_of_birth: null, phone: "5551234" }),
    ];
    const groups = findDuplicatePeople(people, new Map());
    expect(groups[0]?.members).toEqual([
      { id: "1", date_of_birth: "2010-01-01" },
      { id: "2", date_of_birth: null },
    ]);
  });

  it("keeps the person with the most linked participants as keeper", () => {
    const people = [person({ id: "1" }), person({ id: "2" })];
    const participantsByPerson = new Map([
      ["1", [{ id: "p1" }]],
      ["2", [{ id: "p2" }, { id: "p3" }]],
    ]);
    const groups = findDuplicatePeople(people, participantsByPerson);
    expect(groups[0]?.keeperId).toBe("2");
  });

  it("breaks a participant-count tie in favor of a directus_user_id", () => {
    const people = [person({ id: "1" }), person({ id: "2", directus_user_id: "du-1" })];
    const groups = findDuplicatePeople(people, new Map());
    expect(groups[0]?.keeperId).toBe("2");
  });

  it("breaks a remaining tie in favor of the smallest id", () => {
    const people = [person({ id: "b" }), person({ id: "a" })];
    const groups = findDuplicatePeople(people, new Map());
    expect(groups[0]?.keeperId).toBe("a");
  });
});

describe("planPersonMerge", () => {
  it("relinks every duplicate's participants to the keeper", () => {
    const keeper = person({ id: "keep" });
    const duplicates = [person({ id: "dup" })];
    const steps = planPersonMerge(
      keeper,
      duplicates,
      related({
        participants: [
          { id: "part-1", person_id: "dup" },
          { id: "part-2", person_id: "keep" },
          { id: "part-3", person_id: "other" },
        ],
      }),
    );
    expect(steps).toContainEqual({
      type: "update",
      collection: "participants",
      id: "part-1",
      patch: { person_id: "keep" },
    });
    expect(steps.filter((step) => step.collection === "participants")).toHaveLength(1);
  });

  it("fills the keeper's null medical fields from a duplicate, then deletes the duplicate's profile", () => {
    const keeper = person({ id: "keep" });
    const duplicates = [person({ id: "dup" })];
    const keeperProfile: MergeMedicalProfile = {
      id: "mp-keep",
      person_id: "keep",
      allergies: null,
      medications: "ibuprofen",
      conditions: null,
      physician_name: null,
      physician_phone: null,
      last_tetanus: null,
      weight: null,
    };
    const dupProfile: MergeMedicalProfile = {
      id: "mp-dup",
      person_id: "dup",
      allergies: "peanuts",
      medications: "aspirin",
      conditions: "asthma",
      physician_name: null,
      physician_phone: null,
      last_tetanus: null,
      weight: 80,
    };
    const steps = planPersonMerge(keeper, duplicates, related({ medicalProfiles: [keeperProfile, dupProfile] }));

    expect(steps).toContainEqual({
      type: "update",
      collection: "medical_profiles",
      id: "mp-keep",
      patch: { allergies: "peanuts", conditions: "asthma", weight: 80 },
    });
    expect(steps).toContainEqual({ type: "delete", collection: "medical_profiles", ids: ["mp-dup"] });
  });

  it("promotes a duplicate's medical profile to the keeper when the keeper has none", () => {
    const keeper = person({ id: "keep" });
    const duplicates = [person({ id: "dup" })];
    const dupProfile: MergeMedicalProfile = {
      id: "mp-dup",
      person_id: "dup",
      allergies: "peanuts",
      medications: null,
      conditions: null,
      physician_name: null,
      physician_phone: null,
      last_tetanus: null,
      weight: null,
    };
    const steps = planPersonMerge(keeper, duplicates, related({ medicalProfiles: [dupProfile] }));

    expect(steps).toContainEqual({
      type: "update",
      collection: "medical_profiles",
      id: "mp-dup",
      patch: { person_id: "keep" },
    });
    expect(steps.some((step) => step.type === "delete" && step.collection === "medical_profiles")).toBe(false);
  });

  it("fills medical fields from the first duplicate in order that has a value", () => {
    const keeper = person({ id: "keep" });
    const duplicates = [person({ id: "dup1" }), person({ id: "dup2" })];
    const keeperProfile: MergeMedicalProfile = {
      id: "mp-keep",
      person_id: "keep",
      allergies: null,
      medications: null,
      conditions: null,
      physician_name: null,
      physician_phone: null,
      last_tetanus: null,
      weight: null,
    };
    const profile1: MergeMedicalProfile = {
      id: "mp-1",
      person_id: "dup1",
      allergies: "peanuts",
      medications: null,
      conditions: null,
      physician_name: null,
      physician_phone: null,
      last_tetanus: null,
      weight: null,
    };
    const profile2: MergeMedicalProfile = {
      id: "mp-2",
      person_id: "dup2",
      allergies: "shellfish",
      medications: null,
      conditions: null,
      physician_name: null,
      physician_phone: null,
      last_tetanus: null,
      weight: null,
    };
    const steps = planPersonMerge(
      keeper,
      duplicates,
      related({ medicalProfiles: [keeperProfile, profile1, profile2] }),
    );
    expect(steps).toContainEqual({
      type: "update",
      collection: "medical_profiles",
      id: "mp-keep",
      patch: { allergies: "peanuts" },
    });
  });

  it("repoints a contact and deletes the one it collapses onto", () => {
    const keeper = person({ id: "keep" });
    const duplicates = [person({ id: "dup" })];
    const contacts: MergeContact[] = [
      { id: "c1", subject_id: "dup", contact_id: "other", relationship_type: "guardian" },
      { id: "c2", subject_id: "keep", contact_id: "other", relationship_type: "guardian" },
    ];
    const steps = planPersonMerge(keeper, duplicates, related({ contacts }));
    expect(steps).toContainEqual({ type: "delete", collection: "contacts", ids: ["c1"] });
    expect(steps.some((step) => step.type === "update" && step.collection === "contacts")).toBe(false);
  });

  it("deletes a contact that repointing makes self-referential", () => {
    const keeper = person({ id: "keep" });
    const duplicates = [person({ id: "dup" })];
    const contacts: MergeContact[] = [
      { id: "c1", subject_id: "dup", contact_id: "keep", relationship_type: "guardian" },
    ];
    const steps = planPersonMerge(keeper, duplicates, related({ contacts }));
    expect(steps).toContainEqual({ type: "delete", collection: "contacts", ids: ["c1"] });
  });

  it("repoints an unambiguous contact without deleting it", () => {
    const keeper = person({ id: "keep" });
    const duplicates = [person({ id: "dup" })];
    const contacts: MergeContact[] = [
      { id: "c1", subject_id: "dup", contact_id: "other", relationship_type: "guardian" },
    ];
    const steps = planPersonMerge(keeper, duplicates, related({ contacts }));
    expect(steps).toContainEqual({
      type: "update",
      collection: "contacts",
      id: "c1",
      patch: { subject_id: "keep", contact_id: "other" },
    });
  });

  it("unions contact_points and drops a duplicate on (person_id, kind, normalized)", () => {
    const keeper = person({ id: "keep" });
    const duplicates = [person({ id: "dup" })];
    const contactPoints: MergeContactPoint[] = [
      { id: "cp1", person_id: "dup", kind: "email", normalized: "a@example.com" },
      { id: "cp2", person_id: "keep", kind: "email", normalized: "a@example.com" },
      { id: "cp3", person_id: "dup", kind: "phone", normalized: "5551234" },
    ];
    const steps = planPersonMerge(keeper, duplicates, related({ contactPoints }));
    expect(steps).toContainEqual({ type: "delete", collection: "contact_points", ids: ["cp1"] });
    expect(steps).toContainEqual({
      type: "update",
      collection: "contact_points",
      id: "cp3",
      patch: { person_id: "keep" },
    });
  });

  it("repoints program_role_assignments and event_staff with no de-dup", () => {
    const keeper = person({ id: "keep" });
    const duplicates = [person({ id: "dup" })];
    const programRoleAssignments: MergePersonReference[] = [{ id: "pra1", person_id: "dup" }];
    const eventStaff: MergePersonReference[] = [{ id: "es1", person_id: "dup" }];
    const steps = planPersonMerge(keeper, duplicates, related({ programRoleAssignments, eventStaff }));
    expect(steps).toContainEqual({
      type: "update",
      collection: "program_role_assignments",
      id: "pra1",
      patch: { person_id: "keep" },
    });
    expect(steps).toContainEqual({
      type: "update",
      collection: "event_staff",
      id: "es1",
      patch: { person_id: "keep" },
    });
  });

  it("moves a duplicate's directus_user_id to the keeper when the keeper has none", () => {
    const keeper = person({ id: "keep", directus_user_id: null });
    const duplicates = [person({ id: "dup", directus_user_id: "du-1" })];
    const steps = planPersonMerge(keeper, duplicates, related());
    expect(steps).toContainEqual({
      type: "update",
      collection: "people",
      id: "keep",
      patch: { directus_user_id: "du-1" },
    });
  });

  it("throws instead of merging when two rows in the group already have a directus_user_id", () => {
    const keeper = person({ id: "keep", directus_user_id: "du-keep" });
    const duplicates = [person({ id: "dup", directus_user_id: "du-dup" })];
    expect(() => planPersonMerge(keeper, duplicates, related())).toThrow();
  });

  it("fills the keeper's null scalar with a duplicate's non-null value", () => {
    const keeper = person({ id: "keep", email: null, gender: "F" });
    const duplicates = [person({ id: "dup", email: "keep@example.com", gender: "M" })];
    const steps = planPersonMerge(keeper, duplicates, related());
    expect(steps).toContainEqual({
      type: "update",
      collection: "people",
      id: "keep",
      patch: { email: "keep@example.com" },
    });
  });

  it("deletes every duplicate person last", () => {
    const keeper = person({ id: "keep" });
    const duplicates = [person({ id: "dup1" }), person({ id: "dup2" })];
    const steps = planPersonMerge(keeper, duplicates, related());
    const last = steps[steps.length - 1];
    expect(last).toEqual({ type: "delete", collection: "people", ids: ["dup1", "dup2"] });
  });

  it("emits no people update when the keeper already has every value", () => {
    const keeper = person({ id: "keep", email: "keep@example.com" });
    const duplicates = [person({ id: "dup", email: "dup@example.com" })];
    const steps = planPersonMerge(keeper, duplicates, related());
    expect(steps.some((step) => step.collection === "people" && step.type === "update")).toBe(false);
  });
});
