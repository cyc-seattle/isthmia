import { describe, expect, it } from "vitest";
import { PersonRow, ProgramRoleRow } from "@cyc-seattle/crm";
import { isCurrentProgramRole, planProgramManagers, ProgramRoleTables } from "../src/roles.js";
import { GoogleGroupRoleRow } from "../src/schema.js";

const now = new Date("2026-06-15T00:00:00Z");

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

function programRole(overrides: Partial<ProgramRoleRow>): ProgramRoleRow {
  return {
    id: "role-1",
    person_id: "person-1",
    program_id: "program-1",
    role_id: "type-1",
    starts_on: null,
    ends_on: null,
    ...overrides,
  };
}

function groupRole(programRoleTypeId: string, googleRole: GoogleGroupRoleRow["google_role"]): GoogleGroupRoleRow {
  return { id: "gr-1", program_role_type_id: programRoleTypeId, google_role: googleRole };
}

function tables(overrides: Partial<ProgramRoleTables>): ProgramRoleTables {
  return { programRoles: [], groupRoles: [], people: [], ...overrides };
}

describe("isCurrentProgramRole", () => {
  it("is true with no starts_on or ends_on", () => {
    expect(isCurrentProgramRole({ starts_on: null, ends_on: null }, now)).toBe(true);
  });

  it("is false when starts_on is in the future", () => {
    expect(isCurrentProgramRole({ starts_on: "2026-08-01T00:00:00Z", ends_on: null }, now)).toBe(false);
  });

  it("is false when ends_on is in the past", () => {
    expect(isCurrentProgramRole({ starts_on: null, ends_on: "2026-01-01T00:00:00Z" }, now)).toBe(false);
  });

  it("is true when now is within the window", () => {
    expect(isCurrentProgramRole({ starts_on: "2026-01-01T00:00:00Z", ends_on: "2026-08-01T00:00:00Z" }, now)).toBe(
      true,
    );
  });
});

describe("planProgramManagers", () => {
  it("grants the mapped role for a current program_roles row", () => {
    const result = planProgramManagers(
      "program-1",
      tables({
        programRoles: [programRole({ person_id: "coordinator", role_id: "parent-coordinator" })],
        groupRoles: [groupRole("parent-coordinator", "MANAGER")],
        people: [person("coordinator", "coordinator@example.com")],
      }),
      now,
    );

    expect(result).toEqual([{ email: "coordinator@example.com", role: "MANAGER" }]);
  });

  it("excludes a program_roles row outside its starts_on/ends_on window", () => {
    const result = planProgramManagers(
      "program-1",
      tables({
        programRoles: [
          programRole({ person_id: "coordinator", role_id: "parent-coordinator", starts_on: "2026-08-01T00:00:00Z" }),
        ],
        groupRoles: [groupRole("parent-coordinator", "MANAGER")],
        people: [person("coordinator", "coordinator@example.com")],
      }),
      now,
    );

    expect(result).toEqual([]);
  });

  it("grants nothing for a role type with no google_group_roles row", () => {
    const result = planProgramManagers(
      "program-1",
      tables({
        programRoles: [programRole({ person_id: "coordinator", role_id: "unmapped-role" })],
        groupRoles: [],
        people: [person("coordinator", "coordinator@example.com")],
      }),
      now,
    );

    expect(result).toEqual([]);
  });

  it("excludes a program_roles row for a different program", () => {
    const result = planProgramManagers(
      "program-1",
      tables({
        programRoles: [
          programRole({ person_id: "coordinator", role_id: "parent-coordinator", program_id: "program-2" }),
        ],
        groupRoles: [groupRole("parent-coordinator", "MANAGER")],
        people: [person("coordinator", "coordinator@example.com")],
      }),
      now,
    );

    expect(result).toEqual([]);
  });
});
