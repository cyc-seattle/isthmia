/** Row shape for the `sync_tasks` collection: the durable queue every sync package's job runs on.
 * See `schema.yaml`. */
export type SyncTaskStatus = "pending" | "running" | "done" | "failed" | "cancelled";

export interface SyncTaskRow {
  id?: string;
  /** Which sync owns this task, e.g. `"clubspot-sync"` or `"gsuite-sync"`. */
  queue: string;
  /** The task type within its queue, e.g. `"sync_offering"`. Not a schema enum - each queue defines its own. */
  kind: string;
  /** Composed identity, `queue:kind:target` - see `taskKey`. Unique, so re-enqueuing the same
   * task updates this row instead of piling up a duplicate. */
  key: string;
  /** The task that enqueued this one, if any - what makes a run a readable tree in the Directus admin UI. */
  parent_id?: string | null;
  status: SyncTaskStatus;
  attempts: number;
  max_attempts: number;
  /** Not claimable before this time. Null (or past) means claimable now. */
  run_after?: string | null;
  last_error?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
}
