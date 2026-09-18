import { describe, it, expect } from "vitest";
import { SyncProgramRun } from "@cyc-seattle/crm";
import { BASE_INTERVAL_MS, MAX_INTERVAL_MS, campBackoff } from "../src/backoff.js";

const NOW = new Date("2026-01-15T12:00:00Z");

function run(
  campId: string,
  startedAt: string,
  status: SyncProgramRun["status"],
  counts: { created?: number; updated?: number } = {},
): SyncProgramRun {
  return {
    run_id: "run-1",
    clubspot_camp_id: campId,
    started_at: startedAt,
    finished_at: startedAt,
    status,
    items_created: counts.created ?? 0,
    items_updated: counts.updated ?? 0,
    items_skipped: 0,
  };
}

describe("campBackoff", () => {
  it("is due when the camp has no prior runs", () => {
    expect(campBackoff("camp-1", [], NOW).due).toBe(true);
  });

  it("is due on the next run after a sync that wrote something", () => {
    const startedAt = new Date(NOW.getTime() - BASE_INTERVAL_MS);
    const priorRuns = [run("camp-1", startedAt.toISOString(), "ok", { created: 1 })];
    expect(campBackoff("camp-1", priorRuns, NOW).due).toBe(true);
  });

  it("does not lengthen the interval when a run fails", () => {
    // A failure means "we don't know", not "nothing changed". Counting it as empty would make a
    // camp that errors every run progressively stop being retried.
    const hour = 60 * 60 * 1000;
    const priorRuns = [
      run("camp-1", new Date(NOW.getTime() - 6 * hour).toISOString(), "failed"),
      run("camp-1", new Date(NOW.getTime() - 12 * hour).toISOString(), "failed"),
      run("camp-1", new Date(NOW.getTime() - 18 * hour).toISOString(), "failed"),
    ];
    expect(campBackoff("camp-1", priorRuns, NOW).intervalMs).toBe(BASE_INTERVAL_MS);
    expect(campBackoff("camp-1", priorRuns, NOW).due).toBe(true);
  });

  it("keeps a backed-off camp's interval across a failure, without growing it", () => {
    const hour = 60 * 60 * 1000;
    // Two empty successes put the camp at 4x base; the later failure must not make it 8x.
    const priorRuns = [
      run("camp-1", new Date(NOW.getTime() - 1 * hour).toISOString(), "failed"),
      run("camp-1", new Date(NOW.getTime() - 30 * hour).toISOString(), "ok"),
      run("camp-1", new Date(NOW.getTime() - 60 * hour).toISOString(), "ok"),
      run("camp-1", new Date(NOW.getTime() - 90 * hour).toISOString(), "ok", { updated: 3 }),
    ];
    expect(campBackoff("camp-1", priorRuns, NOW).intervalMs).toBe(BASE_INTERVAL_MS * 4);
  });

  it("is not due before the base interval elapses", () => {
    const startedAt = new Date(NOW.getTime() - BASE_INTERVAL_MS + 1000);
    const priorRuns = [run("camp-1", startedAt.toISOString(), "ok", { created: 1 })];
    expect(campBackoff("camp-1", priorRuns, NOW).due).toBe(false);
  });

  it("lengthens the interval with each consecutive empty run", () => {
    const oneEmpty = [run("camp-1", NOW.toISOString(), "ok")];
    const twoEmpty = [run("camp-1", NOW.toISOString(), "ok"), run("camp-1", NOW.toISOString(), "ok")];

    const { intervalMs: afterOne } = campBackoff("camp-1", oneEmpty, NOW);
    const { intervalMs: afterTwo } = campBackoff("camp-1", twoEmpty, NOW);

    expect(afterOne).toBeGreaterThan(BASE_INTERVAL_MS);
    expect(afterTwo).toBeGreaterThan(afterOne);
  });

  it("caps the interval at one week", () => {
    const manyEmptyRuns = Array.from({ length: 10 }, () => run("camp-1", NOW.toISOString(), "ok"));
    expect(campBackoff("camp-1", manyEmptyRuns, NOW).intervalMs).toBe(MAX_INTERVAL_MS);
  });

  it("resets the interval when the most recent run wrote something", () => {
    const priorRuns = [
      run("camp-1", "2026-01-01T00:00:00Z", "ok"),
      run("camp-1", "2026-01-08T00:00:00Z", "ok"),
      run("camp-1", NOW.toISOString(), "ok", { updated: 1 }),
    ];
    expect(campBackoff("camp-1", priorRuns, NOW).intervalMs).toBe(BASE_INTERVAL_MS);
  });

  it("ignores skipped rows entirely, for both the last-attempt clock and the empty-run count", () => {
    const wroteSomething = new Date(NOW.getTime() - BASE_INTERVAL_MS * 3);
    const withSkip = [
      run("camp-1", wroteSomething.toISOString(), "ok", { created: 1 }),
      run("camp-1", NOW.toISOString(), "skipped"), // must not count as an empty run or move the clock
    ];
    const withoutSkip = [run("camp-1", wroteSomething.toISOString(), "ok", { created: 1 })];

    expect(campBackoff("camp-1", withSkip, NOW)).toEqual(campBackoff("camp-1", withoutSkip, NOW));
  });

  it("only considers rows for the requested camp", () => {
    const priorRuns = [run("camp-2", NOW.toISOString(), "ok", { created: 1 })];
    expect(campBackoff("camp-1", priorRuns, NOW).due).toBe(true);
  });
});
