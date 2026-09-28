import { DirectusClient } from "./client.js";

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

/** A run's outcome, closed out by `finishSyncRun` - the caller's own counts, keyed however it likes. */
export interface SyncRunOutcome {
  status: SyncRunStatus;
  counts: Record<string, number>;
  error?: string | undefined;
}

/**
 * Starts this execution's `sync_runs` row. A dry run's `createItems` no-ops and returns the input
 * with no id (see `DirectusClient`); returning `undefined` there lets the caller skip the closing
 * update instead of trying to patch a row that was never written. A real run with no id back is a
 * write that silently failed, so it throws instead of limping on with no history.
 */
export async function startSyncRun(
  directus: DirectusClient,
  source: string,
  startedAt: Date,
): Promise<SyncRunRow | undefined> {
  const [created] = await directus.createItems<SyncRunRow>("sync_runs", [
    { source, started_at: startedAt.toISOString(), status: "running" },
  ]);
  if (!created?.id) {
    if (directus.isDryRun) {
      return undefined;
    }
    throw new Error("Directus did not return the created sync_runs row");
  }
  return created;
}

/** Closes out this execution's `sync_runs` row with its outcome. */
export async function finishSyncRun(
  directus: DirectusClient,
  runId: string,
  finishedAt: Date,
  outcome: SyncRunOutcome,
): Promise<void> {
  await directus.updateItem<SyncRunRow>("sync_runs", runId, {
    finished_at: finishedAt.toISOString(),
    status: outcome.status,
    counts: outcome.counts,
    error: outcome.error ?? null,
  });
}
