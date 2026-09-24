import { CampRow, ClassRow } from "@cyc-seattle/clubspot";
import { ProgramRow } from "@cyc-seattle/crm";
import { AuditFindingRow } from "@cyc-seattle/directus";
import { describe, expect, it } from "vitest";
import {
  AuditFindingInput,
  findClassesWithoutProgram,
  findMismatchedRevenueAccounts,
  fingerprintFinding,
  findProgramsWithoutGroup,
  findStaleMembers,
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

  it("raises nothing for an unplanned manager, since managers are hand-managed (#156)", () => {
    const result = findUnexpectedMembers(
      { email: "class@cyccommunitysailing.org" },
      ["planned@example.com"],
      [{ email: "coaches@cyccommunitysailing.org", role: "MANAGER" }],
    );

    expect(result).toEqual([]);
  });

  it("still raises a finding for an unplanned owner", () => {
    const result = findUnexpectedMembers(
      { email: "class@cyccommunitysailing.org" },
      ["planned@example.com"],
      [{ email: "stray-owner@example.com", role: "OWNER" }],
    );

    expect(result.map((finding) => finding.kind)).toEqual(["unexpected_member"]);
  });
});

describe("findStaleMembers", () => {
  it("raises a finding for a live member in the unwindowed plan but not the windowed one", () => {
    const result = findStaleMembers(
      { email: "class@cyccommunitysailing.org" },
      ["current@example.com"],
      ["current@example.com", "aged-out@example.com"],
      [{ email: "aged-out@example.com", role: "MEMBER" }],
    );

    expect(result).toEqual([
      {
        source: "gsuite-sync",
        kind: "stale_member",
        subject: "class@cyccommunitysailing.org",
        detail:
          "aged-out@example.com is a member of class@cyccommunitysailing.org from a past season outside the membership window",
      },
    ]);
  });

  it("raises nothing for a member who is in the windowed plan", () => {
    const result = findStaleMembers(
      { email: "class@cyccommunitysailing.org" },
      ["current@example.com"],
      ["current@example.com"],
      [{ email: "current@example.com", role: "MEMBER" }],
    );

    expect(result).toEqual([]);
  });

  it("raises nothing for an aged-out manager, since managers are hand-managed (#156)", () => {
    const result = findStaleMembers(
      { email: "class@cyccommunitysailing.org" },
      ["current@example.com"],
      ["current@example.com", "aged-out@example.com"],
      [{ email: "aged-out@example.com", role: "MANAGER" }],
    );

    expect(result).toEqual([]);
  });

  it("raises nothing for a member in neither plan - that's unexpected_member's job", () => {
    const result = findStaleMembers(
      { email: "class@cyccommunitysailing.org" },
      [],
      [],
      [{ email: "stranger@example.com", role: "MEMBER" }],
    );

    expect(result).toEqual([]);
  });
});

describe("findProgramsWithoutGroup", () => {
  function program(overrides: Partial<ProgramWithGoogleGroup>): ProgramWithGoogleGroup {
    return { id: "program-1", name: "Double-handed", revenue_account: null, google_group_id: null, ...overrides };
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

describe("findClassesWithoutProgram", () => {
  function cls(overrides: Partial<ClassRow>): ClassRow {
    return {
      id: "class-1",
      camp_id: "camp-1",
      name: "Optimist",
      program_id: null,
      ...overrides,
    };
  }

  it("raises a finding for a class with no program_id", () => {
    const result = findClassesWithoutProgram([cls({ program_id: null })]);

    expect(result).toEqual([
      {
        source: "clubspot-sync",
        kind: "class_without_program",
        subject: "class-1",
        detail: 'Class "Optimist" (class-1) has no program_id',
      },
    ]);
  });

  it("raises nothing for a class with a program_id set", () => {
    const result = findClassesWithoutProgram([cls({ program_id: "program-1" })]);

    expect(result).toEqual([]);
  });
});

describe("findMismatchedRevenueAccounts", () => {
  function camp(
    overrides: Partial<Pick<CampRow, "id" | "name" | "clubspot_sales_account">>,
  ): Pick<CampRow, "id" | "name" | "clubspot_sales_account"> {
    return { id: "camp-1", name: "2026 Fall Double-handed", clubspot_sales_account: "4000-YOUTH", ...overrides };
  }

  function cls(overrides: Partial<ClassRow>): ClassRow {
    return { id: "class-1", camp_id: "camp-1", name: "J-Pod", program_id: "program-1", ...overrides };
  }

  function program(
    overrides: Partial<Pick<ProgramRow, "id" | "revenue_account">>,
  ): Pick<ProgramRow, "id" | "revenue_account"> {
    return { id: "program-1", revenue_account: "4000-YOUTH", ...overrides };
  }

  it("raises a finding when a camp's classes map to two distinct non-null revenue_account values", () => {
    const result = findMismatchedRevenueAccounts(
      [camp({})],
      [cls({ id: "class-1", program_id: "program-1" }), cls({ id: "class-2", program_id: "program-2" })],
      [
        program({ id: "program-1", revenue_account: "4000-YOUTH" }),
        program({ id: "program-2", revenue_account: "4100-ADULT" }),
      ],
    );

    expect(result).toEqual([
      {
        source: "clubspot-sync",
        kind: "mismatched_revenue_account",
        subject: "camp-1",
        detail:
          'Camp "2026 Fall Double-handed" (camp-1, sales account 4000-YOUTH) has classes mapped to programs with different revenue_account values: 4000-YOUTH, 4100-ADULT',
      },
    ]);
  });

  it("raises nothing when every class maps to the same revenue_account", () => {
    const result = findMismatchedRevenueAccounts(
      [camp({})],
      [cls({ id: "class-1", program_id: "program-1" }), cls({ id: "class-2", program_id: "program-2" })],
      [
        program({ id: "program-1", revenue_account: "4000-YOUTH" }),
        program({ id: "program-2", revenue_account: "4000-YOUTH" }),
      ],
    );

    expect(result).toEqual([]);
  });

  it("raises nothing when a program's revenue_account is null", () => {
    const result = findMismatchedRevenueAccounts(
      [camp({})],
      [cls({ id: "class-1", program_id: "program-1" }), cls({ id: "class-2", program_id: "program-2" })],
      [
        program({ id: "program-1", revenue_account: "4000-YOUTH" }),
        program({ id: "program-2", revenue_account: null }),
      ],
    );

    expect(result).toEqual([]);
  });
});

describe("planAuditFindingWrites", () => {
  it("creates a fresh finding with no matching row", () => {
    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([finding()], []);

    expect(toCreate).toEqual([finding()]);
    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([]);
  });

  it("does not re-raise a finding whose fingerprint already exists as dismissed", () => {
    const dismissed = existingRow({ status: "dismissed" });

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([finding()], [dismissed]);

    expect(toCreate).toEqual([]);
    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([]);
  });

  it("produces one row when the same finding is raised twice in one run", () => {
    const { toCreate } = planAuditFindingWrites([finding(), finding()], []);

    expect(toCreate).toEqual([finding()]);
  });

  it("resolves, rather than deletes, an open row whose condition no longer reproduces this run", () => {
    const stale = existingRow({ status: "open" });

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([], [stale]);

    expect(toCreate).toEqual([]);
    expect(toResolve).toEqual([stale]);
    expect(toReopen).toEqual([]);
  });

  it("leaves a dismissed row alone even when its condition no longer reproduces this run", () => {
    const dismissed = existingRow({ status: "dismissed" });

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([], [dismissed]);

    expect(toCreate).toEqual([]);
    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([]);
  });

  it("leaves an open row alone, and creates nothing, when the same finding is raised again", () => {
    const open = existingRow({ status: "open" });

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([finding()], [open]);

    expect(toCreate).toEqual([]);
    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([]);
  });

  it("reopens a resolved row whose fingerprint recurs this run, rather than creating a duplicate", () => {
    const resolved = existingRow({ status: "resolved" });

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([finding()], [resolved]);

    expect(toCreate).toEqual([]);
    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([resolved]);
  });

  it("leaves a resolved row alone when its condition still doesn't reproduce", () => {
    const resolved = existingRow({ status: "resolved" });

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([], [resolved]);

    expect(toCreate).toEqual([]);
    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([]);
  });

  it("ignores a row from a kind this pass doesn't own", () => {
    const foreign = existingRow({ status: "open", kind: "some_other_syncs_kind", fingerprint: "unrelated" });

    const { toCreate, toResolve, toReopen } = planAuditFindingWrites([], [foreign]);

    expect(toCreate).toEqual([]);
    expect(toResolve).toEqual([]);
    expect(toReopen).toEqual([]);
  });
});
