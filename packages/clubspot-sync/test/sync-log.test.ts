import { describe, it, expect } from "vitest";
import { EPOCH, SyncProgramRun, watermarkForCamp } from "../src/sync-log.js";

function run(campId: string, startedAt: string, status: SyncProgramRun["status"]): SyncProgramRun {
  return {
    run_id: "run-1",
    clubspot_camp_id: campId,
    started_at: startedAt,
    finished_at: startedAt,
    status,
    items_created: 0,
    items_updated: 0,
  };
}

describe("watermarkForCamp", () => {
  it("returns the epoch when the camp has no prior runs", () => {
    expect(watermarkForCamp("camp-1", [])).toEqual(EPOCH);
  });

  it("returns the epoch when the camp has runs, but none succeeded", () => {
    const runs = [run("camp-1", "2026-01-01T00:00:00Z", "failed"), run("camp-1", "2026-01-02T00:00:00Z", "skipped")];
    expect(watermarkForCamp("camp-1", runs)).toEqual(EPOCH);
  });

  it("picks the greatest started_at among ok rows, ignoring failed and skipped rows", () => {
    const runs = [
      run("camp-1", "2026-01-01T00:00:00Z", "ok"),
      run("camp-1", "2026-01-03T00:00:00Z", "failed"), // later, but not ok
      run("camp-1", "2026-01-02T00:00:00Z", "ok"),
      run("camp-1", "2026-01-04T00:00:00Z", "skipped"), // later, but not ok
    ];
    expect(watermarkForCamp("camp-1", runs)).toEqual(new Date("2026-01-02T00:00:00Z"));
  });

  it("ignores rows belonging to a different camp", () => {
    const runs = [run("camp-1", "2026-01-01T00:00:00Z", "ok"), run("camp-2", "2026-01-05T00:00:00Z", "ok")];
    expect(watermarkForCamp("camp-1", runs)).toEqual(new Date("2026-01-01T00:00:00Z"));
  });
});
