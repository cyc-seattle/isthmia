import { ProgramRow } from "@cyc-seattle/crm";

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
