import { ContactRelationshipType, ContactRow, PersonRow } from "@cyc-seattle/crm";
import { ContactPointWithParticipant, ParticipantRow } from "@cyc-seattle/clubspot";
import { DirectusClient } from "@cyc-seattle/directus";
import {
  applyContactPointPlan,
  ContactPointCandidateWithParticipant,
  ContactPointSlot,
  contactPointCandidatesFromSlots,
  contactPointKeySet,
  planContactPointUpserts,
  planStaffContactPoints,
} from "./contact-points.js";

/** A guardian/emergency slot's resolved person, from the `contacts` row `person-sync.ts` already wrote for it. */
function contactIdForSlot(
  contacts: readonly ContactRow[],
  subjectId: string,
  relationshipType: ContactRelationshipType,
  contactOrder: number,
): string | null {
  return (
    contacts.find(
      (row) =>
        row.subject_id === subjectId &&
        row.relationship_type === relationshipType &&
        row.contact_order === contactOrder,
    )?.contact_id ?? null
  );
}

/**
 * The mirror holds every form value but not who a guardian or emergency-contact slot resolved to
 * - that's on `contacts`, keyed by the minor's `person_id` - so seeding looks it up the same way
 * `person-sync.ts` does for an existing slot.
 */
export function slotsForMirroredParticipant(
  participant: ParticipantRow,
  contacts: readonly ContactRow[],
): ContactPointSlot[] {
  if (!participant.person_id) {
    return [];
  }
  const subjectId = participant.person_id;
  return [
    { personId: subjectId, email: participant.email, phone: participant.phone },
    {
      personId: contactIdForSlot(contacts, subjectId, "guardian", 1),
      email: participant.guardian_1_email,
      phone: participant.guardian_1_mobile,
    },
    {
      personId: contactIdForSlot(contacts, subjectId, "guardian", 2),
      email: participant.guardian_2_email,
      phone: participant.guardian_2_mobile,
    },
    {
      personId: contactIdForSlot(contacts, subjectId, "emergency_contact", 1),
      email: participant.emergency_1_email,
      phone: participant.emergency_1_phone,
    },
    {
      personId: contactIdForSlot(contacts, subjectId, "emergency_contact", 2),
      email: participant.emergency_2_email,
      phone: participant.emergency_2_phone,
    },
  ];
}

export interface SeedContactPointsResult {
  participantsProcessed: number;
  formContactPointsCreated: number;
  formContactPointsTouched: number;
  formValuesSkipped: number;
  staffContactPointsCreated: number;
}

/**
 * Migration step 4, run once from the CLI's `--seed-contact-points` flag: backfills
 * `contact_points` for every participant already in the mirror, then adds a `staff` row for any
 * `people.email`/`people.phone` no form covered. Idempotent - a rerun's form pass upserts on the
 * same keys, and the gap-fill pass skips anything already on file, including what the form pass
 * itself just created.
 */
export async function seedContactPoints(directus: DirectusClient, now: Date): Promise<SeedContactPointsResult> {
  const [participants, contacts, existingContactPoints, people] = await Promise.all([
    directus.readItems<ParticipantRow>("participants", { limit: -1 }),
    directus.readItems<ContactRow>("contacts", { limit: -1 }),
    directus.readItems<ContactPointWithParticipant>("contact_points", { limit: -1 }),
    directus.readItems<PersonRow>("people", { limit: -1, fields: ["id", "email", "phone"] }),
  ]);

  const candidates: ContactPointCandidateWithParticipant[] = [];
  let participantsProcessed = 0;
  for (const participant of participants) {
    if (!participant.person_id) {
      continue;
    }
    participantsProcessed++;
    for (const candidate of contactPointCandidatesFromSlots(slotsForMirroredParticipant(participant, contacts))) {
      candidates.push({ ...candidate, participantId: participant.id });
    }
  }

  const formPlan = planContactPointUpserts(candidates, existingContactPoints, now);
  const formCounts = await applyContactPointPlan(directus, formPlan);

  const keysAfterForms = new Set([
    ...contactPointKeySet(existingContactPoints),
    ...contactPointKeySet(formPlan.toCreate),
  ]);
  const staffRows = planStaffContactPoints(people, keysAfterForms, now);
  if (staffRows.length > 0) {
    await directus.createItems<ContactPointWithParticipant>("contact_points", staffRows);
  }

  return {
    participantsProcessed,
    formContactPointsCreated: formCounts.created,
    formContactPointsTouched: formCounts.touched,
    formValuesSkipped: formPlan.skipped,
    staffContactPointsCreated: staffRows.length,
  };
}
