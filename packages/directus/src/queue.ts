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

/**
 * Tasks still `running` when a new run starts. Cloud Run job parallelism is pinned at 1, so a
 * `running` row found at the start of a run can only mean the worker that claimed it died before
 * finishing - no concurrent worker could still be holding it. That is a different guarantee from
 * `planClaim`'s: that one rules out two workers racing the same claim mid-run; this one rules out a
 * second worker owning a task left `running` by a worker that crashed. Both rely on parallelism
 * being 1, but if that ever changes, sweeping stale `running` rows needs a real lease.
 */
export function staleRunningTasks(tasks: readonly SyncTaskRow[]): SyncTaskRow[] {
  return tasks.filter((task) => task.status === "running");
}

/** The row patch to un-strand a task found `running` at the start of a run: back to `pending`,
 * `attempts` untouched since the crash wasn't a completed attempt. */
export function planSweep(): Partial<SyncTaskRow> {
  return { status: "pending", started_at: null };
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
 * The row patch to claim a task. Plain read-then-update, no lease column or optimistic lock -
 * safe only because Cloud Run job parallelism is 1, so no two workers can ever race the same claim.
 * That guards contention, not a crash mid-task: a worker that dies after this patch leaves the row
 * stuck `running` forever, which is what `staleRunningTasks` and `planSweep` recover from.
 */
export function planClaim(task: Pick<SyncTaskRow, "attempts">, now: Date): Partial<SyncTaskRow> {
  return { status: "running", attempts: task.attempts + 1, started_at: now.toISOString() };
}

/** A success resets `attempts` so it counts *consecutive* failures, not a lifetime total. */
export function planSuccess(now: Date): Partial<SyncTaskRow> {
  return { status: "done", finished_at: now.toISOString(), last_error: null, attempts: 0, needs_attention: false };
}

/**
 * After a failed attempt, always retry with backoff - `max_attempts` is a loudness threshold, not
 * a stop sign. A Clubspot or Google outage must self-heal once it clears, not sit parked until a
 * human re-enqueues every affected task by hand; silently going quiet on a real camp or group is
 * the failure this queue exists to avoid. Once `attempts` reaches `max_attempts`, `needs_attention`
 * flags the task so staff can find it without stopping the retries.
 * `task.attempts` must already reflect the attempt that just failed (see `planClaim`).
 */
export function planFailure(task: SyncTaskRow, error: string, now: Date): Partial<SyncTaskRow> {
  return {
    status: "pending",
    run_after: nextRunAfter(task.attempts, now).toISOString(),
    last_error: error,
    needs_attention: hasExhaustedAttempts(task),
  };
}

/**
 * Retires a task whose target evaporated after it was enqueued - a class or group a handler
 * expected to find is gone, so retrying can never succeed. Terminal like `failed`, but doesn't
 * count as a failure against the run that notices it.
 */
export function planCancel(reason: string, now: Date): Partial<SyncTaskRow> {
  return { status: "cancelled", finished_at: now.toISOString(), last_error: reason };
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
 *
 * `existing` is the row this key already resolves to, if any - the caller looks it up, this stays
 * pure. While it isn't `done`, its `attempts`, `last_error`, and `needs_attention` carry forward,
 * so a task that has failed every run for two weeks still reads that way after tonight's discovery
 * re-enqueues it. `cancelled` is terminal, but re-enqueuing one means it's back in scope for a
 * reason unrelated to why it was cancelled, so it starts fresh like a brand new task.
 */
export function planEnqueue(
  input: EnqueueInput,
  existing: SyncTaskRow | undefined,
  now: Date,
): Omit<SyncTaskRow, "id"> {
  const carryForward = existing != null && existing.status !== "done" && existing.status !== "cancelled";
  return {
    queue: input.queue,
    kind: input.kind,
    key: taskKey(input),
    parent_id: input.parentId ?? null,
    status: "pending",
    attempts: carryForward ? existing.attempts : 0,
    max_attempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    run_after: now.toISOString(),
    last_error: carryForward ? (existing.last_error ?? null) : null,
    needs_attention: carryForward ? existing.needs_attention : false,
    started_at: null,
    finished_at: null,
  };
}
