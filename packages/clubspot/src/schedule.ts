/**
 * Row shapes for the `camps`, `sessions`, `classes`, `session_classes`, and `entry_caps`
 * collections. See `schema.yaml`.
 */

/** A dated event (Clubspot's Camp). Its programs are derived - the distinct programs of its classes. */
export interface CampRow {
  /** The Clubspot Camp objectId - assigned by the sync, not generated. */
  id: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  archived: boolean;
  /** The Clubspot chart-of-accounts code this camp sells against, or null if it has none. */
  clubspot_sales_account: string | null;
}

export interface SessionRow {
  /** The Clubspot CampSession objectId - assigned by the sync, not generated. */
  id: string;
  camp_id: string;
  name: string | null;
  start_date: string | null;
  end_date: string | null;
  archived: boolean;
}

/** `program_id` is set by staff, never by the sync - see `planClasses`. */
export interface ClassRow {
  /** The Clubspot CampClass objectId - assigned by the sync, not generated. */
  id: string;
  camp_id: string;
  name: string;
  program_id: string | null;
}

export interface SessionClassRow {
  /** The join of `session_id` and `class_id` (`"<session id>:<class id>"`), assigned by the sync. */
  id: string;
  session_id: string;
  class_id: string;
}

export interface EntryCapRow {
  /** The Clubspot EntryCap objectId - assigned by the sync, not generated. */
  id: string;
  class_id: string;
  /** Null means the cap applies to the class across every session (`EntryCapAttributes.campSessionObject` is unset). */
  session_id: string | null;
  cap: number;
}
