/** Row shape for the `sync_runs` collection: one row per job execution. See `schema.yaml`. */
export type SyncRunStatus = "running" | "succeeded" | "failed";

export interface SyncRunRow {
  id?: string;
  /** Which job ran, e.g. `"clubspot-sync"`. */
  source: string;
  started_at: string;
  finished_at?: string | null;
  status: SyncRunStatus;
  counts?: Record<string, number> | null;
  error?: string | null;
}
