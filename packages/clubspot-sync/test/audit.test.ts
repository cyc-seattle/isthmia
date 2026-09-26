import { describe, it, expect } from "vitest";
import { DuplicatePersonGroup, MergePerson } from "../src/merge.js";
import { findDuplicatePersonFindings, findUnlinkedParticipantFindings } from "../src/audit.js";

function person(overrides: Partial<Pick<MergePerson, "id" | "first_name" | "last_name">> & { id: string }) {
  return { first_name: "Jane", last_name: "Doe", ...overrides };
}

describe("findDuplicatePersonFindings", () => {
  it("names the finding after the keeper and lists every member's id and date of birth, no email or phone", () => {
    const group: DuplicatePersonGroup = {
      keeperId: "person-1",
      members: [
        { id: "person-1", date_of_birth: "2010-01-01" },
        { id: "person-2", date_of_birth: "2011-02-02" },
      ],
    };
    const people = [person({ id: "person-1", first_name: "Jane", last_name: "Doe" })];

    const [finding] = findDuplicatePersonFindings([group], people);

    expect(finding).toMatchObject({ source: "clubspot-sync", kind: "duplicate_person", subject: "person-1" });
    expect(finding!.detail).toBe("Jane Doe: person-1 (dob 2010-01-01), person-2 (dob 2011-02-02)");
    expect(finding!.detail).not.toMatch(/@|\d{3}-?\d{3}-?\d{4}/);
  });

  it("produces the same detail across two calls with the same input, so the fingerprint is stable", () => {
    const group: DuplicatePersonGroup = {
      keeperId: "person-1",
      members: [
        { id: "person-1", date_of_birth: "2010-01-01" },
        { id: "person-2", date_of_birth: null },
      ],
    };
    const people = [person({ id: "person-1" })];

    const first = findDuplicatePersonFindings([group], people);
    const second = findDuplicatePersonFindings([group], people);

    expect(first).toEqual(second);
  });

  it("falls back to the keeper's id when no matching person row is given", () => {
    const group: DuplicatePersonGroup = { keeperId: "person-1", members: [{ id: "person-1", date_of_birth: null }] };

    const [finding] = findDuplicatePersonFindings([group], []);

    expect(finding!.detail).toBe("person-1: person-1 (dob unknown)");
  });
});

describe("findUnlinkedParticipantFindings", () => {
  it("raises a finding for a participant with no linked person, carrying only its id and name", () => {
    const findings = findUnlinkedParticipantFindings([
      { id: "participant-1", person_id: null, first_name: "Jane", last_name: "Doe" },
    ]);

    expect(findings).toEqual([
      {
        source: "clubspot-sync",
        kind: "unlinked_participant",
        subject: "participant-1",
        detail: "participant-1 (Jane Doe)",
      },
    ]);
  });

  it("raises nothing for a participant that already has a linked person", () => {
    const findings = findUnlinkedParticipantFindings([
      { id: "participant-1", person_id: "person-1", first_name: "Jane", last_name: "Doe" },
    ]);

    expect(findings).toEqual([]);
  });
});
