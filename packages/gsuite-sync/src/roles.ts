import { PersonRow, ProgramRoleRow } from "@cyc-seattle/crm";
import { GoogleGroupRole, GoogleGroupRoleRow } from "./schema.js";

/**
 * Whether a `program_roles` row is in effect on `now`. Durable by default: a null `starts_on` or
 * `ends_on` is unbounded on that side, so no dates at all means current forever.
 */
export function isCurrentProgramRole(row: Pick<ProgramRoleRow, "starts_on" | "ends_on">, now: Date): boolean {
  const started = row.starts_on == null || new Date(row.starts_on) <= now;
  const notEnded = row.ends_on == null || new Date(row.ends_on) >= now;
  return started && notEnded;
}

export interface ProgramRoleTables {
  programRoles: readonly ProgramRoleRow[];
  groupRoles: readonly GoogleGroupRoleRow[];
  people: readonly PersonRow[];
}

export interface GroupRoleAssignment {
  email: string;
  role: GoogleGroupRole;
}

/**
 * The member-role pairs a program's Google Group should have from its current `program_roles`:
 * each row's `role_id` maps through `google_group_roles` to a Google role. A role type with no
 * mapping row there grants nothing on Google Groups - that's the design, not a gap. Add-only, like
 * membership: never diffed against who's already there.
 */
export function planProgramManagers(programId: string, tables: ProgramRoleTables, now: Date): GroupRoleAssignment[] {
  const roleByType = new Map(tables.groupRoles.map((row) => [row.program_role_type_id, row.google_role]));
  const personById = new Map(
    tables.people.filter((person) => person.id).map((person) => [person.id as string, person]),
  );

  const assignments: GroupRoleAssignment[] = [];
  for (const row of tables.programRoles) {
    if (row.program_id !== programId || !isCurrentProgramRole(row, now)) {
      continue;
    }
    const role = roleByType.get(row.role_id);
    if (!role) {
      continue;
    }
    const person = personById.get(row.person_id);
    if (person?.email) {
      assignments.push({ email: person.email.trim().toLowerCase(), role });
    }
  }
  return assignments;
}
