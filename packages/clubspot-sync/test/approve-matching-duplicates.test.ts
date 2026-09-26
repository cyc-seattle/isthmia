import { describe, it, expect } from "vitest";
import { AuditFindingRow } from "@cyc-seattle/directus";
import { selectMatchingDuplicateFindings } from "../src/approve-matching-duplicates.js";

function finding(
  overrides: Partial<AuditFindingRow> & Pick<AuditFindingRow, "id" | "subject" | "detail">,
): AuditFindingRow {
  return {
    source: "clubspot-sync",
    kind: "duplicate_person",
    status: "open",
    fingerprint: `fp-${overrides.id}`,
    ...overrides,
  };
}

function person(id: string, dateOfBirth: string | null) {
  return { id, first_name: "Jane", last_name: "Doe", date_of_birth: dateOfBirth };
}

describe("selectMatchingDuplicateFindings", () => {
  it("approves a finding whose group rows all share one non-null date_of_birth", () => {
    const people = new Map([
      ["person-1", person("person-1", "2010-01-01")],
      ["person-2", person("person-2", "2010-01-01")],
    ]);
    const group = finding({
      id: "finding-1",
      subject: "person-1",
      detail: "Jane Doe: person-1 (dob 2010-01-01), person-2 (dob 2010-01-01)",
    });

    const { toApprove, leftOpen } = selectMatchingDuplicateFindings([group], people);

    expect(leftOpen).toEqual([]);
    expect(toApprove).toEqual([{ finding: group, name: "jane doe", groupSize: 2 }]);
  });

  it("leaves a finding open when one row's date_of_birth is null", () => {
    const people = new Map([
      ["person-1", person("person-1", "2010-01-01")],
      ["person-2", person("person-2", null)],
    ]);
    const group = finding({
      id: "finding-2",
      subject: "person-1",
      detail: "Jane Doe: person-1 (dob 2010-01-01), person-2 (dob unknown)",
    });

    const { toApprove, leftOpen } = selectMatchingDuplicateFindings([group], people);

    expect(toApprove).toEqual([]);
    expect(leftOpen).toEqual([{ finding: group, reason: "null_dob" }]);
  });

  it("leaves a finding open when the group's rows have differing dates of birth", () => {
    const people = new Map([
      ["person-1", person("person-1", "2010-01-01")],
      ["person-2", person("person-2", "2011-02-02")],
    ]);
    const group = finding({
      id: "finding-3",
      subject: "person-1",
      detail: "Jane Doe: person-1 (dob 2010-01-01), person-2 (dob 2011-02-02)",
    });

    const { toApprove, leftOpen } = selectMatchingDuplicateFindings([group], people);

    expect(toApprove).toEqual([]);
    expect(leftOpen).toEqual([{ finding: group, reason: "differing_dob" }]);
  });

  it("ignores a finding that isn't open", () => {
    const people = new Map([
      ["person-1", person("person-1", "2010-01-01")],
      ["person-2", person("person-2", "2010-01-01")],
    ]);
    const approvedAlready = finding({
      id: "finding-4",
      subject: "person-1",
      status: "approved",
      detail: "Jane Doe: person-1 (dob 2010-01-01), person-2 (dob 2010-01-01)",
    });
    const dismissed = finding({
      id: "finding-5",
      subject: "person-1",
      status: "dismissed",
      detail: "Jane Doe: person-1 (dob 2010-01-01), person-2 (dob 2010-01-01)",
    });

    const { toApprove, leftOpen } = selectMatchingDuplicateFindings([approvedAlready, dismissed], people);

    expect(toApprove).toEqual([]);
    expect(leftOpen).toEqual([]);
  });

  it("leaves a finding open when one of its group's people no longer exists", () => {
    const people = new Map([["person-1", person("person-1", "2010-01-01")]]);
    const group = finding({
      id: "finding-6",
      subject: "person-1",
      detail: "Jane Doe: person-1 (dob 2010-01-01), person-2 (dob 2010-01-01)",
    });

    const { toApprove, leftOpen } = selectMatchingDuplicateFindings([group], people);

    expect(toApprove).toEqual([]);
    expect(leftOpen).toEqual([{ finding: group, reason: "missing_person" }]);
  });
});
