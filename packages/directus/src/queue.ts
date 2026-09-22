import { SyncTaskRow } from "./sync-tasks.js";

/** A fresh task's default retry budget, when the caller enqueuing it doesn't specify one. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** Retry backoff after a failed attempt: doubles per attempt, capped at an hour. */
export const BASE_RETRY_MS = 60 * 1000;
export const RETRY_BACKOFF_FACTOR = 2;
export const MAX_RETRY_MS = 60 * 60 * 1000;

/** A null (or past) `run_after` means the task was never deferred, or its deferral has elapsed. */
export function isDue(runAfter: string | null | undefined, now: Date): boolean {
  return runAfter == null || new Date(runAfter).getTime() <= now.getTime();
}

/** Which of a set of tasks a worker may claim right now. Pending and due, regardless of `parent_id` -
 * the queue is a flat set of claimable rows; the tree it forms is for the Directus admin UI, not the worker. */
export function claimableTasks(tasks: readonly SyncTaskRow[], now: Date): SyncTaskRow[] {
  return tasks.filter((task) => task.status === "pending" && isDue(task.run_after, now));
}

/** Whether a task, after its most recent attempt, has spent its whole retry budget. */
export function hasExhaustedAttempts(task: Pick<SyncTaskRow, "attempts" | "max_attempts">): boolean {
  return task.attempts >= task.max_attempts;
}

/** How long to wait before the next retry, given how many attempts have been made so far. */
export function nextRunAfter(attempts: number, now: Date): Date {
  const delayMs = Math.min(BASE_RETRY_MS * RETRY_BACKOFF_FACTOR ** Math.max(attempts - 1, 0), MAX_RETRY_MS);
  return new Date(now.getTime() + delayMs);
}

/**
 * The row patch to claim a task.
 *
 * This is a plain read-then-update: one worker per queue (Cloud Run job parallelism of 1) means no
 * two claims can race, so there is no lease column and no optimistic lock. If a second worker is
 * ever run against the same queue concurrently, this needs one.
 */
export function planClaim(task: Pick<SyncTaskRow, "attempts">, now: Date): Partial<SyncTaskRow> {
  return { status: "running", attempts: task.attempts + 1, started_at: now.toISOString() };
}

export function planSuccess(now: Date): Partial<SyncTaskRow> {
  return { status: "done", finished_at: now.toISOString(), last_error: null };
}

/**
 * After a failed attempt: retry with backoff, or fail permanently once `max_attempts` is spent.
 * `task.attempts` must already reflect the attempt that just failed (see `planClaim`).
 */
export function planFailure(task: SyncTaskRow, error: string, now: Date): Partial<SyncTaskRow> {
  if (hasExhaustedAttempts(task)) {
    return { status: "failed", finished_at: now.toISOString(), last_error: error };
  }
  return { status: "pending", run_after: nextRunAfter(task.attempts, now).toISOString(), last_error: error };
}

export interface EnqueueInput {
  queue: string;
  kind: string;
  /** The natural key of the thing this task acts on, e.g. a group address or an offering id. */
  target: string;
  parentId?: string | null;
  maxAttempts?: number;
}

/**
 * The row's unique `key`, composed rather than taken raw from the caller.
 *
 * Directus's schema format has only single-column uniqueness, but the identity of a task is
 * (queue, kind, target): one group needs both a `members` and a `settings` task at once, and a
 * bare target would make the second enqueue overwrite the first and silently drop that work.
 */
export function taskKey(input: Pick<EnqueueInput, "queue" | "kind" | "target">): string {
  return `${input.queue}:${input.kind}:${input.target}`;
}

/**
 * Recovers a task's target from its composed key - the inverse of `taskKey`. A handler is only
 * ever handed the claimed row, so this is how it gets back the natural key `taskKey` folded in.
 */
export function targetFromKey(task: Pick<SyncTaskRow, "queue" | "kind" | "key">): string {
  const prefix = `${task.queue}:${task.kind}:`;
  if (!task.key.startsWith(prefix)) {
    throw new Error(`Task key "${task.key}" doesn't start with its own queue:kind prefix "${prefix}"`);
  }
  return task.key.slice(prefix.length);
}

/**
 * The full row for a (re-)enqueued task, reset to pending regardless of any prior run. `key` is
 * unique in the schema, so the executor updates the one existing row with this key rather than
 * inserting a duplicate - this is the plan for either case.
 */
export function planEnqueue(input: EnqueueInput, now: Date): Omit<SyncTaskRow, "id"> {
  return {
    queue: input.queue,
    kind: input.kind,
    key: taskKey(input),
    parent_id: input.parentId ?? null,
    status: "pending",
    attempts: 0,
    max_attempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    run_after: now.toISOString(),
    last_error: null,
    started_at: null,
    finished_at: null,
  };
}
