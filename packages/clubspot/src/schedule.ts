/**
 * Row shapes for the `offerings`, `sessions`, `classes`, `session_classes`, and `entry_caps`
 * collections. See `schema.yaml`.
 */

/** A dated instance of a program (Clubspot's Camp). `program_id` is set by staff, never by the sync. */
export interface OfferingRow {
  id?: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  program_id: string | null;
}

export interface SessionRow {
  id?: string;
  offering_id: string;
  name: string | null;
  start_date: string | null;
  end_date: string | null;
  archived: boolean;
}

export interface ClassRow {
  id?: string;
  offering_id: string;
  name: string;
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
