import { describe, it, expect } from "vitest";
import {
  BASE_RETRY_MS,
  claimableTasks,
  hasExhaustedAttempts,
  isDue,
  MAX_RETRY_MS,
  nextRunAfter,
  planClaim,
  planEnqueue,
  planFailure,
  planSuccess,
  planSweep,
  RETRY_BACKOFF_FACTOR,
  staleRunningTasks,
  targetFromKey,
  taskKey,
} from "../src/queue.js";
import { SyncTaskRow } from "../src/sync-tasks.js";

const NOW = new Date("2026-01-15T12:00:00Z");

function task(overrides: Partial<SyncTaskRow> = {}): SyncTaskRow {
  return {
    id: "task-1",
    queue: "clubspot-sync",
    kind: "sync_offering",
    key: "offering-1",
    parent_id: null,
    status: "pending",
    attempts: 0,
    max_attempts: 5,
    run_after: null,
    last_error: null,
    started_at: null,
    finished_at: null,
    needs_attention: false,
    ...overrides,
  };
}

describe("isDue", () => {
  it("is due when run_after is null", () => {
    expect(isDue(null, NOW)).toBe(true);
  });

  it("is due when run_after has already passed", () => {
    expect(isDue(new Date(NOW.getTime() - 1000).toISOString(), NOW)).toBe(true);
  });

  it("is not due when run_after is in the future", () => {
    expect(isDue(new Date(NOW.getTime() + 1000).toISOString(), NOW)).toBe(false);
  });
});

describe("claimableTasks", () => {
  it("keeps a pending task that is due now", () => {
    const due = task({ id: "due", run_after: null });
    expect(claimableTasks([due], NOW)).toEqual([due]);
  });

  it("drops a pending task whose run_after is in the future", () => {
    const notYet = task({ id: "not-yet", run_after: new Date(NOW.getTime() + 60_000).toISOString() });
    expect(claimableTasks([notYet], NOW)).toEqual([]);
  });

  it("drops a task that is not pending, even if it is due", () => {
    const running = task({ id: "running", status: "running", run_after: null });
    const done = task({ id: "done", status: "done", run_after: null });
    const failed = task({ id: "failed", status: "failed", run_after: null });
    expect(claimableTasks([running, done, failed], NOW)).toEqual([]);
  });

  it("does not assume a flat list - a child is claimable independently of its parent", () => {
    const parent = task({ id: "parent", parent_id: null });
    const child = task({ id: "child", parent_id: "parent" });
    expect(claimableTasks([parent, child], NOW)).toEqual([parent, child]);
  });

  it("keeps a task claimable once needs_attention is set - it's a loudness threshold, not a stop sign", () => {
    const flagged = task({ id: "flagged", attempts: 8, max_attempts: 5, needs_attention: true, run_after: null });
    expect(claimableTasks([flagged], NOW)).toEqual([flagged]);
  });
});

describe("staleRunningTasks", () => {
  it("keeps a task still running when a new run starts - parallelism 1 means its worker crashed", () => {
    const stuck = task({ id: "stuck", status: "running" });
    expect(staleRunningTasks([stuck])).toEqual([stuck]);
  });

  it("drops tasks in every other status", () => {
    const pending = task({ id: "pending", status: "pending" });
    const done = task({ id: "done", status: "done" });
    const failed = task({ id: "failed", status: "failed" });
    expect(staleRunningTasks([pending, done, failed])).toEqual([]);
  });
});

describe("planSweep", () => {
  it("returns a task to pending without touching attempts - the crash wasn't a completed attempt", () => {
    expect(planSweep()).toEqual({ status: "pending", started_at: null });
  });
});

describe("hasExhaustedAttempts", () => {
  it("is false below max_attempts", () => {
    expect(hasExhaustedAttempts({ attempts: 4, max_attempts: 5 })).toBe(false);
  });

  it("is true once attempts reaches max_attempts", () => {
    expect(hasExhaustedAttempts({ attempts: 5, max_attempts: 5 })).toBe(true);
  });

  it("is true if attempts somehow exceeds max_attempts", () => {
    expect(hasExhaustedAttempts({ attempts: 6, max_attempts: 5 })).toBe(true);
  });
});

describe("nextRunAfter", () => {
  it("waits the base interval after the first attempt", () => {
    expect(nextRunAfter(1, NOW).getTime()).toBe(NOW.getTime() + BASE_RETRY_MS);
  });

  it("doubles the interval with each further attempt", () => {
    expect(nextRunAfter(2, NOW).getTime()).toBe(NOW.getTime() + BASE_RETRY_MS * RETRY_BACKOFF_FACTOR);
    expect(nextRunAfter(3, NOW).getTime()).toBe(NOW.getTime() + BASE_RETRY_MS * RETRY_BACKOFF_FACTOR ** 2);
  });

  it("caps the interval at MAX_RETRY_MS", () => {
    expect(nextRunAfter(20, NOW).getTime()).toBe(NOW.getTime() + MAX_RETRY_MS);
  });
});

describe("planClaim", () => {
  it("marks the task running, records started_at, and increments attempts", () => {
    expect(planClaim({ attempts: 1 }, NOW)).toEqual({
      status: "running",
      attempts: 2,
      started_at: NOW.toISOString(),
    });
  });
});

describe("planSuccess", () => {
  it("marks the task done, clears any prior error, and resets attempts and needs_attention", () => {
    expect(planSuccess(NOW)).toEqual({
      status: "done",
      finished_at: NOW.toISOString(),
      last_error: null,
      attempts: 0,
      needs_attention: false,
    });
  });
});

describe("planFailure", () => {
  it("schedules a retry when attempts remain", () => {
    const failing = task({ attempts: 2, max_attempts: 5 });
    const patch = planFailure(failing, "boom", NOW);
    expect(patch.status).toBe("pending");
    expect(patch.last_error).toBe("boom");
    expect(patch.run_after).toBe(nextRunAfter(2, NOW).toISOString());
    expect(patch.needs_attention).toBe(false);
  });

  it("stays pending and flags needs_attention once max_attempts is exhausted, rather than stopping", () => {
    const exhausted = task({ attempts: 5, max_attempts: 5 });
    expect(planFailure(exhausted, "boom", NOW)).toEqual({
      status: "pending",
      run_after: nextRunAfter(5, NOW).toISOString(),
      last_error: "boom",
      needs_attention: true,
    });
  });
});

describe("planEnqueue", () => {
  const input = { queue: "clubspot-sync", kind: "sync_offering", target: "offering-1" };

  it("builds a fresh, pending row due immediately when nothing exists yet", () => {
    const row = planEnqueue(input, undefined, NOW);
    expect(row).toEqual({
      queue: "clubspot-sync",
      kind: "sync_offering",
      key: "clubspot-sync:sync_offering:offering-1",
      parent_id: null,
      status: "pending",
      attempts: 0,
      max_attempts: 5,
      run_after: NOW.toISOString(),
      last_error: null,
      needs_attention: false,
      started_at: null,
      finished_at: null,
    });
  });

  it("carries a parent id and a caller-supplied max_attempts", () => {
    const row = planEnqueue(
      { queue: "gsuite-sync", kind: "sync_group", target: "group-1", parentId: "run-1", maxAttempts: 3 },
      undefined,
      NOW,
    );
    expect(row.parent_id).toBe("run-1");
    expect(row.max_attempts).toBe(3);
  });

  it("carries a failing task's attempts, last_error, and needs_attention forward on re-enqueue", () => {
    const existing = task({
      ...input,
      status: "pending",
      attempts: 14,
      last_error: "clubspot is down",
      needs_attention: true,
    });
    const row = planEnqueue(input, existing, NOW);
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(14);
    expect(row.last_error).toBe("clubspot is down");
    expect(row.needs_attention).toBe(true);
  });

  it("carries a running task's attempts forward too - a re-enqueue mid-claim must not lose the count", () => {
    const existing = task({ ...input, status: "running", attempts: 3, last_error: "prior failure" });
    const row = planEnqueue(input, existing, NOW);
    expect(row.attempts).toBe(3);
    expect(row.last_error).toBe("prior failure");
  });

  it("resets a done task to a fresh attempts count", () => {
    const existing = task({ ...input, status: "done", attempts: 4, last_error: null, needs_attention: false });
    const row = planEnqueue(input, existing, NOW);
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBeNull();
    expect(row.needs_attention).toBe(false);
  });

  it("starts a cancelled task fresh, since being re-discovered is unrelated to why it was cancelled", () => {
    const existing = task({
      ...input,
      status: "cancelled",
      attempts: 6,
      last_error: "camp no longer exists",
      needs_attention: true,
    });
    const row = planEnqueue(input, existing, NOW);
    expect(row.attempts).toBe(0);
    expect(row.last_error).toBeNull();
    expect(row.needs_attention).toBe(false);
  });
});

describe("taskKey", () => {
  // The collision this composition exists to prevent: one group needs both a members task and a
  // settings task at the same time, and `key` is globally unique in the schema.
  it("distinguishes two kinds of work on the same target", () => {
    const members = taskKey({ queue: "gsuite-sync", kind: "group_members", target: "j-pod@example.org" });
    const settings = taskKey({ queue: "gsuite-sync", kind: "group_settings", target: "j-pod@example.org" });

    expect(members).not.toBe(settings);
  });

  it("distinguishes two queues acting on the same target", () => {
    expect(taskKey({ queue: "gsuite-sync", kind: "sync", target: "x" })).not.toBe(
      taskKey({ queue: "clubspot-sync", kind: "sync", target: "x" }),
    );
  });

  it("is stable, so a re-enqueue of the same task updates it in place", () => {
    const input = { queue: "gsuite-sync", kind: "group_members", target: "j-pod@example.org" };

    expect(taskKey(input)).toBe(taskKey({ ...input }));
  });
});

describe("targetFromKey", () => {
  it("recovers the target a handler was given only the row for", () => {
    const input = { queue: "clubspot-sync", kind: "sync_offering", target: "camp-1" };
    const claimed = { queue: input.queue, kind: input.kind, key: taskKey(input) };

    expect(targetFromKey(claimed)).toBe("camp-1");
  });

  it("throws if the row's key doesn't match its own queue and kind", () => {
    expect(() =>
      targetFromKey({ queue: "clubspot-sync", kind: "sync_offering", key: "gsuite-sync:sync_group:x" }),
    ).toThrow(/doesn't start with its own queue:kind prefix/);
  });
});
