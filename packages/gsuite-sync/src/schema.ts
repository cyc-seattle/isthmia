import { ClassRow, ProgramRow } from "@cyc-seattle/crm";

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

export type GoogleGroupRole = "MEMBER" | "MANAGER" | "OWNER";

/** Row shape for the `google_group_roles` collection: maps a `program_role_types` row to the
 * Google Group role it grants. Unread until the manager/owner pass. See `schema.yaml`. */
export interface GoogleGroupRoleRow {
  id?: string;
  program_role_type_id: string;
  google_role: GoogleGroupRole;
}

/**
 * `programs.google_group_id` and `classes.google_group_id` are provider extension fields: real
 * columns on `crm`'s collections, declared in this package's `schema.yaml` rather than `crm`'s
 * (see CLAUDE.md's "Canonical collections and providers"). `crm`'s own `ProgramRow` and
 * `ClassRow` don't carry them, so a caller that needs both intersects these with the canonical type.
 */
export interface GoogleGroupFields {
  google_group_id: string | null;
}

export type ProgramWithGoogleGroup = ProgramRow & GoogleGroupFields;
export type ClassWithGoogleGroup = ClassRow & GoogleGroupFields;
