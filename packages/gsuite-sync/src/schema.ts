import { ProgramRow } from "@cyc-seattle/crm";
import { CampRow } from "@cyc-seattle/clubspot";

/** Row shape for the `google_groups` collection: one row per Google Group. See `schema.yaml`. */
export interface GoogleGroupRow {
  id?: string;
  email: string;
  name: string | null;
  /** Name of a `@cyc-seattle/gsuite` settings template (see `resolveGroupSettingsTemplate`), not
   * the settings themselves - staff pick a name, the settings pass resolves it. */
  settings_template: string | null;
  /** The group this one nests under, e.g. a class group's program group. Unread until the nesting pass. */
  parent_id: string | null;
}

/**
 * `programs.google_group_id` is a provider extension field: a real column on `crm`'s `programs`
 * collection, declared in this package's `schema.yaml` rather than `crm`'s (see CLAUDE.md's
 * "Canonical collections and providers"). `crm`'s own `ProgramRow` doesn't carry it, so a caller
 * that needs both intersects this with the canonical type. Groups hang off programs only -
 * `classes` carries no such field.
 */
export interface GoogleGroupFields {
  google_group_id: string | null;
}

export type ProgramWithGoogleGroup = ProgramRow & GoogleGroupFields;

/**
 * `programs.revenue_account` is hand-set by staff directly on `crm`'s own `programs` collection
 * (`packages/crm/schema.yaml`) - unlike `google_group_id` above, it's not this package's field to
 * own. `crm`'s own `ProgramRow` doesn't carry it yet, so `findMismatchedRevenueAccounts`
 * intersects it locally, the same way any caller would for a field its own row type is missing.
 */
export interface RevenueAccountFields {
  revenue_account: string | null;
}

export type ProgramWithRevenueAccount = ProgramRow & RevenueAccountFields;

/**
 * `clubspot_sales_account` is a real field on `clubspot`'s `camps` collection, but part of
 * `clubspot-sync`'s own row types (`CampWithClubspot`), not `packages/clubspot`'s public
 * `CampRow` - only that package's executor and backoff logic read it there. This audit needs it
 * too, to name a mismatched camp's sales account in its finding.
 */
export interface CampSalesAccountFields {
  clubspot_sales_account: string | null;
}

export type CampWithSalesAccount = CampRow & CampSalesAccountFields;
