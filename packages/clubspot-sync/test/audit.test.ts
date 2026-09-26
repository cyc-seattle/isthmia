import { describe, it, expect } from "vitest";
import { AuditFindingRow, fingerprintFinding, planAuditFindingWrites } from "@cyc-seattle/directus";
import { DuplicatePersonGroup, findDuplicatePeople, MergePerson } from "../src/merge.js";
import { AUDIT_FINDING_KINDS, findDuplicatePersonFindings, findUnlinkedParticipantFindings } from "../src/audit.js";

function person(overrides: Partial<Pick<MergePerson, "id" | "first_name" | "last_name">> & { id: string }) {
  return { first_name: "Jane", last_name: "Doe", ...overrides };
}

function mergePerson(overrides: Partial<MergePerson> & { id: string }): MergePerson {
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

describe("reconciling a partly-merged duplicate_person finding", () => {
  it("resolves the reopened finding and raises a fresh one for whatever duplicate remains", () => {
    const originalGroup = findDuplicatePeople(
      [mergePerson({ id: "person-1" }), mergePerson({ id: "person-2" }), mergePerson({ id: "person-3" })],
      new Map(),
    );
    const [originalFinding] = findDuplicatePersonFindings(originalGroup, [mergePerson({ id: "person-1" })]);
    // `finalizeMerge` reopens the finding as-is when a blocked reference stops the delete - person-2
    // merged and was deleted, but person-3's row, and this finding's stale detail naming all three
    // members, are both still here.
    const reopenedFinding: AuditFindingRow = {
      id: "finding-1",
      ...originalFinding!,
      status: "open",
      fingerprint: fingerprintFinding(originalFinding!),
    };

    // This run's detection pass sees current state: person-2 is gone, person-1 and person-3 remain
    // and still share a name.
    const currentGroup = findDuplicatePeople(
      [mergePerson({ id: "person-1" }), mergePerson({ id: "person-3" })],
      new Map(),
    );
    const freshFindings = findDuplicatePersonFindings(currentGroup, [mergePerson({ id: "person-1" })]);

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites(
      freshFindings,
      [reopenedFinding],
      AUDIT_FINDING_KINDS,
    );

    expect(toResolve).toEqual([reopenedFinding]);
    expect(toReopen).toEqual([]);
    expect(toCreate).toEqual([
      expect.objectContaining({
        subject: "person-1",
        detail: "Jane Doe: person-1 (dob unknown), person-3 (dob unknown)",
      }),
    ]);
  });
});
