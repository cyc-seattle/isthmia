/**
 * Row shapes for the `program_role_types` and `program_roles` collections. See `schema.yaml`.
 * Both are hand-entered by staff; no sync writes to either.
 */
export interface ProgramRoleTypeRow {
  id?: string;
  name: string;
}

/**
 * Who someone is to a program. Durable by default: no `starts_on`/`ends_on` means current
 * forever. Separate from `event_staff`, which is person-plus-session and Clubspot-derived.
 */
export interface ProgramRoleRow {
  id?: string;
  person_id: string;
  program_id: string;
  role_id: string;
  starts_on: string | null;
  ends_on: string | null;
}
