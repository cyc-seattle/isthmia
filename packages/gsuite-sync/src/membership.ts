import winston from "winston";
import { ContactRow, isValidEmail, PersonRow, ProgramRoleAssignmentRow } from "@cyc-seattle/crm";
import { CampRow, ClassRow, ParticipantRow, RegistrationEntryRow, RegistrationRow } from "@cyc-seattle/clubspot";
import { isCampInMembershipWindow } from "./camps.js";

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
  camps: readonly CampRow[];
  registrationEntries: readonly RegistrationEntryRow[];
  registrations: readonly RegistrationRow[];
  participants: readonly Pick<ParticipantRow, "id" | "person_id">[];
  people: readonly PersonRow[];
  contacts: readonly ContactRow[];
  programRoleAssignments: readonly ProgramRoleAssignmentRow[];
}

export interface PlanProgramMembersOptions {
  /** Skip the camp membership window so every class contributes its participants regardless of
   * how long ago its camp ended - the "unwindowed" plan the audit compares stale membership
   * against (see `audit.ts`'s `plannedGroupMembers`). Role assignments are never subject to this
   * window either way, so this option has no effect on them. */
  ignoreCampWindow?: boolean;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function addEmail(emails: Set<string>, raw: string): void {
  if (isValidEmail(raw)) {
    emails.add(normalizeEmail(raw));
  }
}

/**
 * The people `planProgramMembers` draws its emails from - participants, their guardians, and
 * current role holders - before any email is checked. The audit uses this to report the unusable
 * addresses that are actually keeping someone out of a group, and nobody else.
 */
export function planProgramMemberPeople(
  programId: string,
  tables: MembershipTables,
  now: Date,
  options: PlanProgramMembersOptions = {},
): PersonRow[] {
  const campById = new Map(tables.camps.filter((row) => row.id).map((row) => [row.id as string, row]));
  const classIds = new Set(
    tables.classes
      .filter((cls) => cls.program_id === programId)
      .filter((cls) => {
        if (options.ignoreCampWindow) {
          return true;
        }
        const camp = campById.get(cls.camp_id);
        return camp != null && isCampInMembershipWindow(camp, now);
      })
      .map((cls) => cls.id),
  );
  const registrationById = new Map(tables.registrations.filter((row) => row.id).map((row) => [row.id as string, row]));
  const personIdByParticipantId = new Map(
    tables.participants
      .filter((row) => row.id && row.person_id)
      .map((row) => [row.id as string, row.person_id as string]),
  );
  const personById = new Map(tables.people.filter((row) => row.id).map((row) => [row.id as string, row]));

  const registrationParticipantIds = new Set(
    tables.registrationEntries
      .filter((entry) => classIds.has(entry.class_id) && entry.status === "confirmed")
      .map((entry) => registrationById.get(entry.registration_id)?.participant_id)
      .filter((participantId): participantId is string => participantId != null),
  );

  const personIds = new Set<string>();
  let unlinkedParticipants = 0;
  for (const participantId of registrationParticipantIds) {
    const personId = personIdByParticipantId.get(participantId);
    if (!personId) {
      unlinkedParticipants++;
      continue;
    }
    personIds.add(personId);
  }
  if (unlinkedParticipants > 0) {
    winston.warn(`Skipped ${unlinkedParticipants} confirmed participants with no resolved person`, {
      programId,
      unlinkedParticipants,
    });
  }

  const people = new Map<string, PersonRow>();
  const include = (personId: string): void => {
    const person = personById.get(personId);
    if (person?.id && person.email) {
      people.set(person.id, person);
    }
  };

  for (const personId of personIds) {
    include(personId);
    for (const contact of tables.contacts) {
      if (contact.subject_id === personId && contact.relationship_type === "guardian") {
        include(contact.contact_id);
      }
    }
  }

  for (const assignment of tables.programRoleAssignments) {
    if (assignment.program_id === programId && isCurrentProgramRole(assignment, now)) {
      include(assignment.person_id);
    }
  }

  return [...people.values()];
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
 *
 * A class only contributes participants when its camp is within the membership window (see
 * `isCampInMembershipWindow`), unless `options.ignoreCampWindow` is set - a class whose camp can't
 * be found at all doesn't contribute either, the same as a camp outside the window. Role
 * assignments are never subject to this window; they have their own `starts_on`/`ends_on` filter
 * and must keep working for a program with no live camp at all (#149).
 */
export function planProgramMembers(
  programId: string,
  tables: MembershipTables,
  now: Date,
  options: PlanProgramMembersOptions = {},
): string[] {
  const emails = new Set<string>();
  for (const person of planProgramMemberPeople(programId, tables, now, options)) {
    addEmail(emails, person.email as string);
  }
  return [...emails].sort();
}
