import { AuditFindingRow } from "@cyc-seattle/directus";
import { describe, expect, it } from "vitest";
import {
  AuditFindingInput,
  fingerprintFinding,
  findProgramsWithoutGroup,
  findUnexpectedMembers,
  planAuditFindingWrites,
} from "../src/audit.js";
import { ProgramWithGoogleGroup } from "../src/schema.js";

function finding(overrides: Partial<AuditFindingInput> = {}): AuditFindingInput {
  return {
    source: "gsuite-sync",
    kind: "unexpected_member",
    subject: "class@cyccommunitysailing.org",
    detail: "extra@example.com is a member of class@cyccommunitysailing.org but isn't in the plan for it",
    ...overrides,
  };
}

function existingRow(overrides: Partial<AuditFindingRow> = {}): AuditFindingRow {
  const base = finding();
  return {
    id: "row-1",
    status: "open",
    fingerprint: fingerprintFinding(base),
    ...base,
    ...overrides,
  };
}

describe("findUnexpectedMembers", () => {
  it("raises a finding for a live member not in the plan", () => {
    const result = findUnexpectedMembers(
      { email: "class@cyccommunitysailing.org" },
      ["planned@example.com"],
      [{ email: "extra@example.com", role: "MEMBER" }],
    );

    expect(result).toEqual([
      {
        source: "gsuite-sync",
        kind: "unexpected_member",
        subject: "class@cyccommunitysailing.org",
        detail: "extra@example.com is a member of class@cyccommunitysailing.org but isn't in the plan for it",
      },
    ]);
  });

  it("raises nothing for a member who is in the plan, case- and whitespace-insensitively", () => {
    const result = findUnexpectedMembers(
      { email: "class@cyccommunitysailing.org" },
      ["planned@example.com"],
      [{ email: " Planned@Example.com ", role: "MEMBER" }],
    );

    expect(result).toEqual([]);
  });
});

describe("findProgramsWithoutGroup", () => {
  function program(overrides: Partial<ProgramWithGoogleGroup>): ProgramWithGoogleGroup {
    return { id: "program-1", name: "Double-handed", google_group_id: null, ...overrides };
  }

  it("raises a finding for a program with no google_group_id", () => {
    const result = findProgramsWithoutGroup([program({ google_group_id: null })]);

    expect(result).toEqual([
      {
        source: "gsuite-sync",
        kind: "program_without_group",
        subject: "program-1",
        detail: 'Program "Double-handed" (program-1) has no google_group_id',
      },
    ]);
  });

  it("raises nothing for a program with a google_group_id set", () => {
    const result = findProgramsWithoutGroup([program({ google_group_id: "group-1" })]);

    expect(result).toEqual([]);
  });
});

describe("planAuditFindingWrites", () => {
  it("creates a fresh finding with no matching row", () => {
    const { toCreate, toDelete } = planAuditFindingWrites([finding()], []);

    expect(toCreate).toEqual([finding()]);
    expect(toDelete).toEqual([]);
  });

  it("does not re-raise a finding whose fingerprint already exists as dismissed", () => {
    const dismissed = existingRow({ status: "dismissed" });

    const { toCreate, toDelete } = planAuditFindingWrites([finding()], [dismissed]);

    expect(toCreate).toEqual([]);
    expect(toDelete).toEqual([]);
  });

  it("produces one row when the same finding is raised twice in one run", () => {
    const { toCreate } = planAuditFindingWrites([finding(), finding()], []);

    expect(toCreate).toEqual([finding()]);
  });

  it("deletes an open row whose condition no longer reproduces this run", () => {
    const stale = existingRow({ status: "open" });

    const { toCreate, toDelete } = planAuditFindingWrites([], [stale]);

    expect(toCreate).toEqual([]);
    expect(toDelete).toEqual([stale]);
  });

  it("leaves a dismissed row alone even when its condition no longer reproduces this run", () => {
    const dismissed = existingRow({ status: "dismissed" });

    const { toCreate, toDelete } = planAuditFindingWrites([], [dismissed]);

    expect(toCreate).toEqual([]);
    expect(toDelete).toEqual([]);
  });

  it("leaves an open row alone, and creates nothing, when the same finding is raised again", () => {
    const open = existingRow({ status: "open" });

    const { toCreate, toDelete } = planAuditFindingWrites([finding()], [open]);

    expect(toCreate).toEqual([]);
    expect(toDelete).toEqual([]);
  });

  it("ignores a row from a kind this pass doesn't own", () => {
    const foreign = existingRow({ status: "open", kind: "some_other_syncs_kind", fingerprint: "unrelated" });

    const { toCreate, toDelete } = planAuditFindingWrites([], [foreign]);

    expect(toCreate).toEqual([]);
    expect(toDelete).toEqual([]);
  });
});
