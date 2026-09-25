/**
 * Row shapes for the `participants`, `registrations`, `registration_entries`,
 * `registration_billing`, `custom_field_definitions`, and `custom_field_responses` collections.
 * See `schema.yaml`.
 */
export interface RegistrationRow {
  /** The Clubspot Registration objectId - assigned by the sync, not generated. */
  id: string;
  /** Nullable during the migration to `participant_id` (#137), which will replace it. */
  person_id: string | null;
  participant_id: string;
  last_sync_run_id: string | null;
  camp_id: string;
  registered_at: string;
  status: string;
  waiver_status: string | null;
  archived: boolean;
}

/**
 * One row per Clubspot Participant objectId - the registration form's own snapshot of the
 * participant, guardian, emergency-contact, and medical answers, held as Clubspot sent them.
 * `id` is the Clubspot objectId itself, assigned by the sync rather than generated, so this
 * collection needs no separate `clubspot_participant_id` column.
 * `person_id` is resolved once, by the matcher, and never re-resolved; staff may repoint it.
 */
export interface ParticipantRow {
  id: string;
  person_id: string | null;
  last_sync_run_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  gender: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  guardian_1_name: string | null;
  guardian_1_email: string | null;
  guardian_1_mobile: string | null;
  guardian_2_name: string | null;
  guardian_2_email: string | null;
  guardian_2_mobile: string | null;
  emergency_1_name: string | null;
  emergency_1_phone: string | null;
  emergency_1_email: string | null;
  emergency_1_relationship: string | null;
  emergency_2_name: string | null;
  emergency_2_phone: string | null;
  emergency_2_email: string | null;
  emergency_2_relationship: string | null;
  medical_conditions: string | null;
  medical_allergies: string | null;
  medical_medications: string | null;
  medical_last_tetanus: string | null;
  medical_physician_name: string | null;
  medical_physician_phone: string | null;
  /** Clubspot's raw numeric-string weight, unparsed - see `parseWeight` in clubspot-sync. */
  medical_weight: string | null;
}

export interface RegistrationEntryRow {
  /** The Clubspot RegistrationCampSession objectId - assigned by the sync, not generated. */
  id: string;
  registration_id: string;
  session_id: string;
  class_id: string;
  status: string;
}

export interface RegistrationBillingRow {
  /** The Clubspot BillingRegistrationAttributes objectId - assigned by the sync, not generated. */
  id: string;
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
  /** The Clubspot CustomField objectId - assigned by the sync, not generated. */
  id: string;
  camp_id: string;
  label: string;
  field_type: string;
  required: boolean;
}

export interface CustomFieldResponseRow {
  /** The join of `registration_id` and `definition_id` (`"<registration id>:<definition id>"`), assigned by the sync. */
  id: string;
  registration_id: string;
  definition_id: string;
  value: string | null;
}
