import { OfferingClubspotFields } from "./schema.js";

/**
 * The run loop's cadence: the Cloud Scheduler trigger runs the job hourly. Paired with
 * `DUE_TOLERANCE_MS` below, an offering that just synced is due again on the very next run.
 */
export const BASE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Slack subtracted from the due threshold. `synced_through` is stamped with the moment an
 * offering's own sync starts, which lags the run's trigger by however long discovery and the
 * offerings ahead of it in the queue took. Without this allowance, an offering that synced on the
 * previous run falls just short of a full interval on the next one and has to wait for the one
 * after.
 */
export const DUE_TOLERANCE_MS = BASE_INTERVAL_MS * 0.05;

/** Doubles the interval per consecutive quiet run - simple, and the PR review only asked for "some reasonable percent". */
export const BACKOFF_FACTOR = 2;

/** The interval never grows past one week, so a backed-off offering is never more than a week stale. */
export const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export interface BackoffDecision {
  /** Whether this run should give the offering a full reconcile. */
  due: boolean;
  /** The interval this decision was made against. Exposed for tests and logging only. */
  intervalMs: number;
}

/**
 * Decides whether an offering is due for a sync this run, from its own `synced_through` and
 * `quiet_runs` columns. Pure: no Directus reads, no clock reads - both are supplied by the caller.
 * Distinct from the queue's own `run_after`, which retries a failed task; this polls a quiet
 * offering less often. `synced_through` advances on every sync, write or not, so `quiet_runs` -
 * consecutive no-write syncs, reset by the next write - is what signals a quiet offering, doubling
 * the interval per count up to the week cap.
 */
export function offeringBackoff(
  offering: Pick<OfferingClubspotFields, "synced_through" | "quiet_runs">,
  now: Date,
): BackoffDecision {
  if (!offering.synced_through) {
    return { due: true, intervalMs: BASE_INTERVAL_MS };
  }

  const intervalMs = Math.min(BASE_INTERVAL_MS * BACKOFF_FACTOR ** offering.quiet_runs, MAX_INTERVAL_MS);
  const due = now.getTime() - new Date(offering.synced_through).getTime() >= intervalMs - DUE_TOLERANCE_MS;

  return { due, intervalMs };
}

/**
 * The offering row's watermark/backoff patch after a successful sync, whether or not it wrote
 * anything. `startedAt` is this offering's own sync start, not the run's - see the tiling rule in
 * the README - so the next sync's watermark begins exactly where this one's read window left off.
 */
export function nextSyncState(
  quietRuns: number,
  wroteSomething: boolean,
  startedAt: Date,
): Pick<OfferingClubspotFields, "synced_through" | "quiet_runs"> {
  return {
    synced_through: startedAt.toISOString(),
    quiet_runs: wroteSomething ? 0 : quietRuns + 1,
  };
}
