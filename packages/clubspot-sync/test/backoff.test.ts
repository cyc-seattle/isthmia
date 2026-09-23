import { describe, it, expect } from "vitest";
import { BASE_INTERVAL_MS, DUE_TOLERANCE_MS, MAX_INTERVAL_MS, nextSyncState, offeringBackoff } from "../src/backoff.js";

const NOW = new Date("2026-01-15T12:00:00Z");

describe("offeringBackoff", () => {
  it("is due when the offering has never synced", () => {
    expect(offeringBackoff({ synced_through: null, quiet_runs: 0 }, NOW).due).toBe(true);
  });

  it("is due on the next run after a sync that wrote something", () => {
    const syncedThrough = new Date(NOW.getTime() - BASE_INTERVAL_MS);
    expect(offeringBackoff({ synced_through: syncedThrough.toISOString(), quiet_runs: 0 }, NOW).due).toBe(true);
  });

  it("is due when the previous sync started slightly less than the interval ago", () => {
    // The setup work between a run's trigger and an offering's own sync start (discovery, the
    // offerings ahead of it) always leaves this kind of shortfall - the case that made an hourly
    // sync run every two hours instead.
    const syncedThrough = new Date(NOW.getTime() - BASE_INTERVAL_MS + DUE_TOLERANCE_MS / 2);
    expect(offeringBackoff({ synced_through: syncedThrough.toISOString(), quiet_runs: 0 }, NOW).due).toBe(true);
  });

  it("is not due before the base interval, less its setup-time tolerance, elapses", () => {
    const syncedThrough = new Date(NOW.getTime() - BASE_INTERVAL_MS + DUE_TOLERANCE_MS + 1000);
    expect(offeringBackoff({ synced_through: syncedThrough.toISOString(), quiet_runs: 0 }, NOW).due).toBe(false);
  });

  it("lengthens the interval with each consecutive quiet run", () => {
    const { intervalMs: afterOne } = offeringBackoff({ synced_through: NOW.toISOString(), quiet_runs: 1 }, NOW);
    const { intervalMs: afterTwo } = offeringBackoff({ synced_through: NOW.toISOString(), quiet_runs: 2 }, NOW);

    expect(afterOne).toBeGreaterThan(BASE_INTERVAL_MS);
    expect(afterTwo).toBeGreaterThan(afterOne);
  });

  it("caps the interval at one week", () => {
    expect(offeringBackoff({ synced_through: NOW.toISOString(), quiet_runs: 10 }, NOW).intervalMs).toBe(
      MAX_INTERVAL_MS,
    );
  });
});

describe("nextSyncState", () => {
  it("advances synced_through and resets quiet_runs when the sync wrote something", () => {
    const startedAt = new Date("2026-01-15T12:00:00Z");
    expect(nextSyncState(4, true, startedAt)).toEqual({ synced_through: startedAt.toISOString(), quiet_runs: 0 });
  });

  it("advances synced_through and increments quiet_runs when the sync wrote nothing", () => {
    const startedAt = new Date("2026-01-15T12:00:00Z");
    expect(nextSyncState(4, false, startedAt)).toEqual({ synced_through: startedAt.toISOString(), quiet_runs: 5 });
  });

  it("starts a never-synced offering's quiet_runs at 1 after its first quiet sync", () => {
    const startedAt = new Date("2026-01-15T12:00:00Z");
    expect(nextSyncState(0, false, startedAt)).toEqual({ synced_through: startedAt.toISOString(), quiet_runs: 1 });
  });
});
