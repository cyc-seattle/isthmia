import { CampRow, RegistrationEntryRow } from "@cyc-seattle/clubspot";

/**
 * Sync-internal bookkeeping columns: real fields on `packages/clubspot`'s collections, but not
 * part of its public row types since only this package's executor and backoff logic read them.
 * A caller that needs both intersects these with the canonical type.
 */
export interface CampClubspotFields {
  /** This camp's own watermark and backoff state - see `backoff.ts`. */
  synced_through: string | null;
  quiet_runs: number;
}

export type CampWithClubspot = CampRow & CampClubspotFields;

export interface RegistrationEntryClubspotFields {
  clubspot_status: string | null;
  confirmed_at: string | null;
  waitlist_number: number | null;
  accepted_from_waitlist: boolean | null;
  priority: number | null;
}

export type RegistrationEntryWithClubspot = RegistrationEntryRow & RegistrationEntryClubspotFields;
