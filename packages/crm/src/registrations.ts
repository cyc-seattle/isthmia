/**
 * Row shapes for the `registrations`, `registration_entries`, `registration_billing`,
 * `custom_field_definitions`, and `custom_field_responses` collections. See `schema.yaml`.
 */
export interface RegistrationRow {
  id?: string;
  person_id: string;
  offering_id: string;
  registered_at: string;
  status: string;
  waiver_status: string | null;
  archived: boolean;
}

export interface RegistrationEntryRow {
  id?: string;
  registration_id: string;
  session_id: string;
  class_id: string;
  status: string;
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
}

export interface CustomFieldDefinitionRow {
  id?: string;
  offering_id: string;
  label: string;
  field_type: string;
  required: boolean;
}

export interface CustomFieldResponseRow {
  id?: string;
  registration_id: string;
  definition_id: string;
  value: string | null;
}
