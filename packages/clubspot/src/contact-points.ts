import type { ContactPointRow } from "@cyc-seattle/crm";

/**
 * `contact_points.participant_id` is a provider extension field: a real column on `crm`'s
 * `contact_points` collection, declared in this package's `schema.yaml` rather than `crm`'s (see
 * CLAUDE.md's "Canonical collections and providers"), because it points at `participants`.
 */
export interface ContactPointParticipantFields {
  participant_id: string | null;
}

export type ContactPointWithParticipant = ContactPointRow & ContactPointParticipantFields;
