import winston from "winston";
import { CampRow, ClassRow, ParticipantRow, RegistrationEntryRow, RegistrationRow } from "@cyc-seattle/clubspot";
import { ContactRow } from "@cyc-seattle/crm";
import { isCampActive } from "./camps.js";
import { PersonWithLoginEmail } from "./schema.js";

/** The rows a family-group plan reads. See `run.ts` for where these come from. */
export interface FamilyGroupTables {
  camps: readonly CampRow[];
  classes: readonly ClassRow[];
  registrationEntries: readonly RegistrationEntryRow[];
  registrations: readonly RegistrationRow[];
  participants: readonly Pick<ParticipantRow, "id" | "person_id">[];
  contacts: readonly ContactRow[];
  people: readonly PersonWithLoginEmail[];
}

export interface FamilyGroupPlan {
  emails: string[];
  /** A current participant with no resolved person, or a current participant or guardian whose
   * `login_email` is null - counted rather than defaulted, since a null login email can't be added
   * to an Authentik group. */
  skipped: number;
}

/**
 * Every distinct `login_email` of a current participant - the `person_id` behind a confirmed
 * `registration_entries` row in a class whose camp is active right now (`isCampActive`) - or of
 * that participant's guardian (`contacts`, `relationship_type` "guardian"). Deduped by
 * `login_email`, since a family commonly shares one address across a parent and a child.
 */
export function planFamilyGroupEmails(tables: FamilyGroupTables, now: Date): FamilyGroupPlan {
  const campById = new Map(tables.camps.filter((row) => row.id).map((row) => [row.id, row]));
  const activeClassIds = new Set(
    tables.classes
      .filter((cls) => {
        const camp = campById.get(cls.camp_id);
        return camp != null && isCampActive(camp, now);
      })
      .map((cls) => cls.id),
  );

  const registrationById = new Map(tables.registrations.filter((row) => row.id).map((row) => [row.id, row]));
  const currentRegistrationIds = new Set(
    tables.registrationEntries
      .filter((entry) => entry.status === "confirmed" && activeClassIds.has(entry.class_id))
      .map((entry) => entry.registration_id),
  );

  const participantById = new Map(tables.participants.filter((row) => row.id).map((row) => [row.id, row]));
  const currentParticipantIds = new Set(
    [...currentRegistrationIds]
      .map((registrationId) => registrationById.get(registrationId)?.participant_id)
      .filter((participantId): participantId is string => participantId != null),
  );

  const personById = new Map(tables.people.filter((row) => row.id).map((row) => [row.id as string, row]));

  let skipped = 0;
  const currentPersonIds = new Set<string>();
  for (const participantId of currentParticipantIds) {
    const personId = participantById.get(participantId)?.person_id;
    if (!personId) {
      skipped++;
      continue;
    }
    currentPersonIds.add(personId);
  }

  const emails = new Set<string>();
  const includeLoginEmail = (personId: string): void => {
    const loginEmail = personById.get(personId)?.login_email;
    if (loginEmail) {
      emails.add(loginEmail);
    } else {
      skipped++;
    }
  };

  for (const personId of currentPersonIds) {
    includeLoginEmail(personId);
    for (const contact of tables.contacts) {
      if (contact.subject_id === personId && contact.relationship_type === "guardian") {
        includeLoginEmail(contact.contact_id);
      }
    }
  }

  if (skipped > 0) {
    winston.warn(`Skipped ${skipped} current participant(s) or guardian(s) with no usable login email`, { skipped });
  }

  return { emails: [...emails].sort(), skipped };
}
