import { SyncProgramRun } from "@cyc-seattle/crm";

/**
 * The run loop's cadence (the Cloud Scheduler trigger, see the design doc's "What the job syncs,
 * and when" section) - a camp that just wrote something is due again on the very next run.
 */
export const BASE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Doubles the interval per consecutive empty run - simple, and the PR review only asked for "some reasonable percent". */
export const BACKOFF_FACTOR = 2;

/** The interval never grows past one week, so a backed-off camp is never more than a week stale. */
export const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface BackoffDecision {
  /** Whether this run should give the camp a full reconcile. */
  due: boolean;
  /** The interval this decision was made against. Exposed for tests and logging only. */
  intervalMs: number;
}

/**
 * Decides whether a camp is due for a sync this run, from its own `sync_program_runs` history.
 * Pure: no Parse queries, no Directus reads, no clock reads - `priorRuns` and `now` are supplied by
 * the caller.
 *
 * `skipped` rows never touched Clubspot, so they carry no information and are ignored entirely -
 * both for finding the last attempt and for counting empty runs. Among what's left, the interval
 * doubles for each consecutive `ok` run that wrote nothing, and resets the moment one writes
 * something.
 *
 * A `failed` run is neither: it means "we don't know", not "nothing changed". It still resets the
 * due timer, so a failure is retried on the camp's current cadence rather than immediately, but it
 * never lengthens the interval. Counting it as empty would make a camp that errors every run - a
 * transient Clubspot fault, or a data shape the mapping rejects - progressively stop being retried,
 * up to a week apart, which is the opposite of what a persistent failure warrants.
 */
export function campBackoff(campId: string, priorRuns: readonly SyncProgramRun[], now: Date): BackoffDecision {
  const attempts = priorRuns
    .filter((run) => run.clubspot_camp_id === campId && run.status !== "skipped")
    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

  const [last] = attempts;
  if (!last) {
    return { due: true, intervalMs: BASE_INTERVAL_MS };
  }

  let consecutiveEmpty = 0;
  for (const attempt of attempts) {
    if (attempt.status === "failed") {
      continue;
    }
    if (attempt.items_created > 0 || attempt.items_updated > 0) {
      break;
    }
    consecutiveEmpty++;
  }

  const intervalMs = Math.min(BASE_INTERVAL_MS * BACKOFF_FACTOR ** consecutiveEmpty, MAX_INTERVAL_MS);
  const due = now.getTime() - new Date(last.started_at).getTime() >= intervalMs;

  return { due, intervalMs };
}
