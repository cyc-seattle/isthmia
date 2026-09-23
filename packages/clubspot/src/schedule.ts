/**
 * Row shapes for the `camps`, `sessions`, `classes`, `session_classes`, and `entry_caps`
 * collections. See `schema.yaml`.
 */

/** A dated event (Clubspot's Camp). Its programs are derived - the distinct programs of its classes. */
export interface CampRow {
  id?: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
}

export interface SessionRow {
  id?: string;
  camp_id: string;
  name: string | null;
  start_date: string | null;
  end_date: string | null;
  archived: boolean;
}

/** `program_id` is set by staff, never by the sync - see `planClasses`. */
export interface ClassRow {
  id?: string;
  camp_id: string;
  name: string;
  program_id: string | null;
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
}
