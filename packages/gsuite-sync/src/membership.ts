import { ContactRow, PersonRow, RegistrationEntryRow, RegistrationRow } from "@cyc-seattle/crm";

/** The rows a class-group membership plan reads. See `run.ts` for where these come from. */
export interface MembershipTables {
  registrationEntries: readonly RegistrationEntryRow[];
  registrations: readonly RegistrationRow[];
  people: readonly PersonRow[];
  contacts: readonly ContactRow[];
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The member emails one class's Google Group should have: participants with a confirmed
 * `registration_entries` row for the class, their guardians, and the participant's own email when
 * set - which is what makes an adult with no guardian row work with no special case. Never
 * emergency contacts. Deduped by lowercased, trimmed email, since a family commonly shares one.
 *
 * Add-only: this is never diffed against live membership. The executor adds every email this
 * returns and treats "already a member" as success (see `DirectoryClient.addMember`), so someone
 * removed from `registration_entries` simply stops being re-added - they're never removed here.
 */
export function planClassMembers(classId: string, tables: MembershipTables): string[] {
  const registrationById = new Map(tables.registrations.filter((row) => row.id).map((row) => [row.id as string, row]));
  const personById = new Map(tables.people.filter((row) => row.id).map((row) => [row.id as string, row]));

  const participantIds = new Set(
    tables.registrationEntries
      .filter((entry) => entry.class_id === classId && entry.status === "confirmed")
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

  return [...emails].sort();
}
