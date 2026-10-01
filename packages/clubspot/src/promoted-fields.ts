import type { PersonRow } from "@cyc-seattle/crm";
import type { RegistrationRow } from "./registrations.js";

/**
 * `people` columns a `promoted_fields` row may target. A code allow-list, not staff config, so a
 * promotion target is type-checked rather than free text.
 */
export const PROMOTABLE_PERSON_FIELDS = ["school"] as const satisfies readonly (keyof PersonRow)[];

export type PromotablePersonField = (typeof PROMOTABLE_PERSON_FIELDS)[number];

/**
 * `registrations` columns a `promoted_fields` row may target - each answered once per
 * registration, rather than carried forward onto the person.
 */
export const PROMOTABLE_REGISTRATION_FIELDS = ["share_contact"] as const satisfies readonly (keyof RegistrationRow)[];

export type PromotableRegistrationField = (typeof PROMOTABLE_REGISTRATION_FIELDS)[number];

/** Row shape for the `promoted_fields` collection. See `schema.yaml`. */
export interface PromotedFieldRow {
  id?: string;
  target_field: PromotablePersonField | PromotableRegistrationField;
  labels: string[];
}
