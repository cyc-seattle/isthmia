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
  RETRY_BACKOFF_FACTOR,
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
  it("marks the task done and clears any prior error", () => {
    expect(planSuccess(NOW)).toEqual({ status: "done", finished_at: NOW.toISOString(), last_error: null });
  });
});

describe("planFailure", () => {
  it("schedules a retry when attempts remain", () => {
    const failing = task({ attempts: 2, max_attempts: 5 });
    const patch = planFailure(failing, "boom", NOW);
    expect(patch.status).toBe("pending");
    expect(patch.last_error).toBe("boom");
    expect(patch.run_after).toBe(nextRunAfter(2, NOW).toISOString());
  });

  it("fails permanently once max_attempts is exhausted", () => {
    const exhausted = task({ attempts: 5, max_attempts: 5 });
    expect(planFailure(exhausted, "boom", NOW)).toEqual({
      status: "failed",
      finished_at: NOW.toISOString(),
      last_error: "boom",
    });
  });
});

describe("planEnqueue", () => {
  it("builds a fresh, pending row due immediately", () => {
    const row = planEnqueue({ queue: "clubspot-sync", kind: "sync_offering", key: "offering-1" }, NOW);
    expect(row).toEqual({
      queue: "clubspot-sync",
      kind: "sync_offering",
      key: "offering-1",
      parent_id: null,
      status: "pending",
      attempts: 0,
      max_attempts: 5,
      run_after: NOW.toISOString(),
      last_error: null,
      started_at: null,
      finished_at: null,
    });
  });

  it("carries a parent id and a caller-supplied max_attempts", () => {
    const row = planEnqueue(
      { queue: "gsuite-sync", kind: "sync_group", key: "group-1", parentId: "run-1", maxAttempts: 3 },
      NOW,
    );
    expect(row.parent_id).toBe("run-1");
    expect(row.max_attempts).toBe(3);
  });
});
