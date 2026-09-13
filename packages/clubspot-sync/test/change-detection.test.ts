import { describe, it, expect } from "vitest";
import { CampChangeInput, ChildCounts, needsSync, REFRESH_FLOOR_MS } from "../src/change-detection.js";

const ZERO_COUNTS: ChildCounts = {
  campSessions: 0,
  campClasses: 0,
  registrations: 0,
  registrationCampSessions: 0,
};

const NOW = new Date("2026-01-15T12:00:00Z");

function input(overrides: Partial<CampChangeInput> = {}): CampChangeInput {
  return {
    campId: "camp-1",
    campUpdatedAt: new Date("2026-01-10T00:00:00Z"),
    childCounts: ZERO_COUNTS,
    watermark: new Date("2026-01-15T00:00:00Z"),
    now: NOW,
    ...overrides,
  };
}

describe("needsSync", () => {
  it("skips a camp with all-zero counts, a recent watermark, and no changes of its own", () => {
    expect(needsSync(input())).toBe(false);
  });

  it("syncs when any one child count is non-zero", () => {
    expect(needsSync(input({ childCounts: { ...ZERO_COUNTS, campSessions: 1 } }))).toBe(true);
    expect(needsSync(input({ childCounts: { ...ZERO_COUNTS, campClasses: 1 } }))).toBe(true);
    expect(needsSync(input({ childCounts: { ...ZERO_COUNTS, registrations: 1 } }))).toBe(true);
    expect(needsSync(input({ childCounts: { ...ZERO_COUNTS, registrationCampSessions: 1 } }))).toBe(true);
  });

  it("syncs when counts are zero but the camp's own updatedAt is newer than the watermark", () => {
    const decision = input({
      watermark: new Date("2026-01-10T00:00:00Z"),
      campUpdatedAt: new Date("2026-01-12T00:00:00Z"),
    });
    expect(needsSync(decision)).toBe(true);
  });

  it("forces a sync once the watermark is more than 24 hours old, despite zero counts and a fresh-looking camp", () => {
    const watermark = new Date(NOW.getTime() - REFRESH_FLOOR_MS - 1);
    const decision = input({
      watermark,
      campUpdatedAt: new Date(watermark.getTime() - 1000), // older than the watermark
      now: NOW,
    });
    expect(needsSync(decision)).toBe(true);
  });

  it("does not force a sync when the watermark is exactly at the 24-hour floor", () => {
    const watermark = new Date(NOW.getTime() - REFRESH_FLOOR_MS);
    const decision = input({
      watermark,
      campUpdatedAt: new Date(watermark.getTime() - 1000),
      now: NOW,
    });
    expect(needsSync(decision)).toBe(false);
  });

  it("always syncs a camp with no prior successful run, since its watermark is the epoch", () => {
    const decision = input({
      watermark: new Date(0),
      campUpdatedAt: new Date("2020-01-01T00:00:00Z"),
      now: NOW,
    });
    expect(needsSync(decision)).toBe(true);
  });
});
