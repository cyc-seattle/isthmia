import { ContactRow, PersonRow, ProgramRoleAssignmentRow } from "@cyc-seattle/crm";
import { ClassRow, RegistrationEntryRow, RegistrationRow } from "@cyc-seattle/clubspot";

/**
 * Whether a `program_role_assignments` row is in effect on `now`. Durable by default: a null
 * `starts_on` or `ends_on` is unbounded on that side, so no dates at all means current forever.
 */
export function isCurrentProgramRole(row: Pick<ProgramRoleAssignmentRow, "starts_on" | "ends_on">, now: Date): boolean {
  const started = row.starts_on == null || new Date(row.starts_on) <= now;
  const notEnded = row.ends_on == null || new Date(row.ends_on) >= now;
  return started && notEnded;
}

/** The rows a program-group membership plan reads. See `run.ts` for where these come from. */
export interface MembershipTables {
  classes: readonly ClassRow[];
  registrationEntries: readonly RegistrationEntryRow[];
  registrations: readonly RegistrationRow[];
  people: readonly PersonRow[];
  contacts: readonly ContactRow[];
  programRoleAssignments: readonly ProgramRoleAssignmentRow[];
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The member emails one program's Google Group should have: participants with a confirmed
 * `registration_entries` row for one of the program's classes (`classes.program_id`), their
 * guardians, the participant's own email when set - which is what makes an adult with no guardian
 * row work with no special case - and every person with a current `program_role_assignments` row
 * for the program. Every role grants plain `MEMBER`; there's no separate manager mapping. Never
 * emergency contacts. Deduped by lowercased, trimmed email, since a family commonly shares one.
 *
 * Add-only: this is never diffed against live membership. The executor adds every email this
 * returns and treats "already a member" as success (see `DirectoryClient.addMember`), so someone
 * removed from `registration_entries` or `program_role_assignments` simply stops being re-added -
 * they're never removed here.
 */
export function planProgramMembers(programId: string, tables: MembershipTables, now: Date): string[] {
  const classIds = new Set(tables.classes.filter((cls) => cls.program_id === programId).map((cls) => cls.id));
  const registrationById = new Map(tables.registrations.filter((row) => row.id).map((row) => [row.id as string, row]));
  const personById = new Map(tables.people.filter((row) => row.id).map((row) => [row.id as string, row]));

  const participantIds = new Set(
    tables.registrationEntries
      .filter((entry) => classIds.has(entry.class_id) && entry.status === "confirmed")
      .map((entry) => registrationById.get(entry.registration_id)?.person_id)
      .filter((personId): personId is string => personId != null),
  );

  const emails = new Set<string>();
  for (const participantId of participantIds) {
    const participant = personById.get(participantId);
    if (participant?.email) {
      emails.add(normalizeEmail(participant.email));
    }

    for (const contact of tables.contacts) {
      if (contact.subject_id !== participantId || contact.relationship_type !== "guardian") {
        continue;
      }
      const guardian = personById.get(contact.contact_id);
      if (guardian?.email) {
        emails.add(normalizeEmail(guardian.email));
      }
    }
  }

  for (const assignment of tables.programRoleAssignments) {
    if (assignment.program_id !== programId || !isCurrentProgramRole(assignment, now)) {
      continue;
    }
    const person = personById.get(assignment.person_id);
    if (person?.email) {
      emails.add(normalizeEmail(person.email));
    }
  }

  return [...emails].sort();
}
