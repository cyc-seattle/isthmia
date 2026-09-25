import winston from "winston";
import { ParticipantRow } from "@cyc-seattle/clubspot";
import { RegistrationWithClubspot } from "./schema.js";

/**
 * Migration step 1 (design doc): before `participants` is populated by the mirror pass (#137), an
 * idempotent link pass gives every registration a `participants` row, reusing
 * `clubspot_participant_id` and `person_id` rather than running the matcher again. Pure: takes CRM
 * rows only, no Directus.
 */
export interface ParticipantLinkPlan {
  /** New `participants` rows, keyed on the Clubspot participant id itself. */
  toCreate: Pick<ParticipantRow, "id" | "person_id">[];
  /** `registrations.participant_id` patches, one per registration this pass links. */
  toLink: { registrationId: string; participantId: string }[];
  /** Registrations with no `clubspot_participant_id` or no `person_id` - can't be linked yet. */
  unlinkable: number;
}

/**
 * Plans a `participants` row for every registration that has none, and the registration's own
 * link patch. A participant already on file - from an earlier run, or an earlier registration in
 * this same call - keeps its stored `person_id`; the matcher sets that once and never again.
 * Idempotent: a registration whose `participant_id` is already set is left alone.
 */
export function planParticipantLinks(
  registrations: readonly RegistrationWithClubspot[],
  participants: readonly ParticipantRow[],
): ParticipantLinkPlan {
  const knownParticipantIds = new Set(participants.map((participant) => participant.id));
  const toCreate: Pick<ParticipantRow, "id" | "person_id">[] = [];
  const plannedParticipantIds = new Set<string>();
  const toLink: { registrationId: string; participantId: string }[] = [];
  let unlinkable = 0;

  for (const registration of registrations) {
    if (registration.participant_id || !registration.id) {
      continue;
    }

    const participantId = registration.clubspot_participant_id;
    const personId = registration.person_id;
    if (!participantId || !personId) {
      unlinkable++;
      continue;
    }

    if (!knownParticipantIds.has(participantId) && !plannedParticipantIds.has(participantId)) {
      toCreate.push({ id: participantId, person_id: personId });
      plannedParticipantIds.add(participantId);
    }
    toLink.push({ registrationId: registration.id, participantId });
  }

  if (unlinkable > 0) {
    winston.warn(`${unlinkable} registration(s) have no clubspot_participant_id or person_id; skipping link`, {
      unlinkable,
    });
  }

  return { toCreate, toLink, unlinkable };
}
