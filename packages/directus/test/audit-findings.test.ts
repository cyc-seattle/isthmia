import { describe, expect, it } from "vitest";
import {
  AuditFindingInput,
  AuditFindingRow,
  fingerprintFinding,
  planAuditFindingWrites,
} from "../src/audit-findings.js";

const ownedKinds = ["unexpected_member"];

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

describe("planAuditFindingWrites", () => {
  it("creates a fresh finding with no matching row", () => {
    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([finding()], [], ownedKinds);

    expect(toCreate).toEqual([finding()]);
    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([]);
  });

  it("does not re-raise a finding whose fingerprint already exists as dismissed", () => {
    const dismissed = existingRow({ status: "dismissed" });

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([finding()], [dismissed], ownedKinds);

    expect(toCreate).toEqual([]);
    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([]);
  });

  it("produces one row when the same finding is raised twice in one run", () => {
    const { toCreate } = planAuditFindingWrites([finding(), finding()], [], ownedKinds);

    expect(toCreate).toEqual([finding()]);
  });

  it("resolves, rather than deletes, an open row whose condition no longer reproduces this run", () => {
    const stale = existingRow({ status: "open" });

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([], [stale], ownedKinds);

    expect(toCreate).toEqual([]);
    expect(toResolve).toEqual([stale]);
    expect(toReopen).toEqual([]);
  });

  it("leaves a dismissed row alone even when its condition no longer reproduces this run", () => {
    const dismissed = existingRow({ status: "dismissed" });

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([], [dismissed], ownedKinds);

    expect(toCreate).toEqual([]);
    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([]);
  });

  it("leaves an open row alone, and creates nothing, when the same finding is raised again", () => {
    const open = existingRow({ status: "open" });

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([finding()], [open], ownedKinds);

    expect(toCreate).toEqual([]);
    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([]);
  });

  it("reopens a resolved row whose fingerprint recurs this run, rather than creating a duplicate", () => {
    const resolved = existingRow({ status: "resolved" });

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([finding()], [resolved], ownedKinds);

    expect(toCreate).toEqual([]);
    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([resolved]);
  });

  it("leaves a resolved row alone when its condition still doesn't reproduce", () => {
    const resolved = existingRow({ status: "resolved" });

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([], [resolved], ownedKinds);

    expect(toCreate).toEqual([]);
    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([]);
  });

  it("ignores a row from a kind not in ownedKinds", () => {
    const foreign = existingRow({ status: "open", kind: "some_other_syncs_kind", fingerprint: "unrelated" });

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([], [foreign], ownedKinds);

    expect(toCreate).toEqual([]);
    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([]);
  });

  it("never resolves or reopens a row of a kind not in ownedKinds, even when its condition changes", () => {
    const openForeign = existingRow({ status: "open", kind: "some_other_syncs_kind", fingerprint: "unrelated" });
    const resolvedForeign = existingRow({
      status: "resolved",
      kind: "some_other_syncs_kind",
      fingerprint: fingerprintFinding(finding({ kind: "some_other_syncs_kind" })),
    });

    const { toResolve, toReopen } = planAuditFindingWrites(
      [finding({ kind: "some_other_syncs_kind" })],
      [openForeign, resolvedForeign],
      ownedKinds,
    );

    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([]);
  });
});
