/**
 * Row shapes for the `registrations`, `registration_entries`, `registration_billing`,
 * `custom_field_definitions`, and `custom_field_responses` collections. See `schema.yaml`.
 */
export interface RegistrationRow {
  id?: string;
  person_id: string;
  program_id: string;
  clubspot_registration_id: string;
  registered_at: string;
  status: string;
  waiver_status: string | null;
  archived: boolean;
  clubspot_participant_id: string | null;
}

export interface RegistrationEntryRow {
  id?: string;
  registration_id: string;
  session_id: string;
  class_id: string;
  status: string;
  clubspot_session_join_id: string;
  clubspot_status: string | null;
  confirmed_at: string | null;
  waitlist_number: number | null;
  accepted_from_waitlist: boolean | null;
  priority: number | null;
}

export interface RegistrationBillingRow {
  id?: string;
  registration_id: string;
  amount: number;
  amount_pending: number;
  amount_received: number;
  amount_refunded: number;
  amount_capturable: number;
  amount_deferred: number;
  deferred_amount_billed: number;
  discount: number;
  processing_fee: number;
  processing_passed_on: number;
  application_fee_amount: number;
  tax: number;
  currency: string | null;
  clubspot_billing_id: string | null;
}

export interface CustomFieldDefinitionRow {
  id?: string;
  program_id: string;
  label: string;
  field_type: string;
  required: boolean;
  clubspot_custom_field_id: string;
}

export interface CustomFieldResponseRow {
  id?: string;
  registration_id: string;
  definition_id: string;
  value: string | null;
}
