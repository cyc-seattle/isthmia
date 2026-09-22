import {
  ClassRow,
  CustomFieldDefinitionRow,
  EntryCapRow,
  OfferingRow,
  RegistrationBillingRow,
  RegistrationEntryRow,
  RegistrationRow,
  SessionRow,
} from "@cyc-seattle/crm";

/**
 * Clubspot extension fields: real columns on `crm`'s collections, declared in this package's
 * `schema.yaml` rather than `crm`'s (see the design doc's "Providers extend canonical
 * collections"). `crm`'s own row types don't carry them, so a caller that needs both intersects
 * these with the canonical type.
 */
export interface OfferingClubspotFields {
  clubspot_camp_id: string;
  /** This offering's own watermark and backoff state - see `backoff.ts`. */
  synced_through: string | null;
  quiet_runs: number;
}

export type OfferingWithClubspot = OfferingRow & OfferingClubspotFields;

export interface SessionClubspotFields {
  clubspot_session_id: string;
}

export type SessionWithClubspot = SessionRow & SessionClubspotFields;

export interface ClassClubspotFields {
  clubspot_class_id: string;
}

export type ClassWithClubspot = ClassRow & ClassClubspotFields;

export interface EntryCapClubspotFields {
  clubspot_entry_cap_id: string;
}

export type EntryCapWithClubspot = EntryCapRow & EntryCapClubspotFields;

export interface RegistrationClubspotFields {
  clubspot_registration_id: string;
  clubspot_participant_id: string | null;
}

export type RegistrationWithClubspot = RegistrationRow & RegistrationClubspotFields;

export interface RegistrationEntryClubspotFields {
  clubspot_session_join_id: string;
  clubspot_status: string | null;
  confirmed_at: string | null;
  waitlist_number: number | null;
  accepted_from_waitlist: boolean | null;
  priority: number | null;
}

export type RegistrationEntryWithClubspot = RegistrationEntryRow & RegistrationEntryClubspotFields;

export interface RegistrationBillingClubspotFields {
  clubspot_billing_id: string | null;
}

export type RegistrationBillingWithClubspot = RegistrationBillingRow & RegistrationBillingClubspotFields;

export interface CustomFieldDefinitionClubspotFields {
  clubspot_custom_field_id: string;
}

export type CustomFieldDefinitionWithClubspot = CustomFieldDefinitionRow & CustomFieldDefinitionClubspotFields;
