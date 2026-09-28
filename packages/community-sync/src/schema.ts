import { PersonRow } from "@cyc-seattle/crm";

/**
 * `people.login_email` is a provider extension field: a real column on `crm`'s `people`
 * collection, declared in this package's `schema.yaml` rather than `crm`'s (see CLAUDE.md's
 * "Canonical collections and providers"). `crm`'s own `PersonRow` doesn't carry it, so a caller
 * that needs both intersects this with the canonical type.
 */
export interface LoginEmailFields {
  login_email: string | null;
}

export type PersonWithLoginEmail = PersonRow & LoginEmailFields;
