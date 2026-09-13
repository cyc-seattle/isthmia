/** Row shapes for the `sync_runs` and `sync_program_runs` collections. See `schema.yaml`. */
export type SyncRunStatus = "running" | "ok" | "failed";
export type ProgramRunStatus = "ok" | "failed" | "skipped";

/** One row per job execution, in the `sync_runs` collection. */
export interface SyncRun {
  id?: string;
  started_at: string;
  finished_at?: string | null;
  status: SyncRunStatus;
  programs_checked: number;
  programs_synced: number;
  error?: string | null;
}

/** One row per camp a run touched, in the `sync_program_runs` collection. */
export interface SyncProgramRun {
  id?: string;
  run_id: string;
  /** Nullable: the first sync of a camp has no `programs` row yet. */
  program_id?: string | null;
  clubspot_camp_id: string;
  started_at: string;
  finished_at?: string | null;
  status: ProgramRunStatus;
  items_created: number;
  items_updated: number;
  error?: string | null;
}
