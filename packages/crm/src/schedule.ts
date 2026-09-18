/**
 * Row shapes for the `programs`, `sessions`, `classes`, `session_classes`, and `entry_caps`
 * collections. See `schema.yaml`.
 */
export interface ProgramRow {
  id?: string;
  name: string;
  clubspot_camp_id: string;
}

export interface SessionRow {
  id?: string;
  program_id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  clubspot_session_id: string;
  archived: boolean;
}

export interface ClassRow {
  id?: string;
  program_id: string;
  name: string;
  clubspot_class_id: string;
}

export interface SessionClassRow {
  id?: string;
  session_id: string;
  class_id: string;
}

export interface EntryCapRow {
  id?: string;
  class_id: string;
  /** Null means the cap applies to the class across every session (`EntryCapAttributes.campSessionObject` is unset). */
  session_id: string | null;
  cap: number;
  clubspot_entry_cap_id: string;
}
