import { describe, expect, it, vi } from "vitest";
import { DirectusClient } from "../src/client.js";
import { finishSyncRun, startSyncRun, SyncRunRow } from "../src/sync-runs.js";

/** A hand-rolled stand-in for the one `DirectusClient` surface these helpers call. */
function fakeDirectus(overrides: Partial<Pick<DirectusClient, "createItems" | "updateItem" | "isDryRun">> = {}) {
  return {
    createItems: vi.fn(),
    updateItem: vi.fn(),
    isDryRun: false,
    ...overrides,
  } as unknown as DirectusClient;
}

describe("startSyncRun", () => {
  it("creates a running sync_runs row and returns it", async () => {
    const startedAt = new Date("2026-01-15T12:00:00Z");
    const createItems = vi.fn().mockResolvedValue([{ id: "run-1", source: "clubspot-sync" }]);
    const directus = fakeDirectus({ createItems });

    const run = await startSyncRun(directus, "clubspot-sync", startedAt);

    expect(createItems).toHaveBeenCalledWith("sync_runs", [
      { source: "clubspot-sync", started_at: startedAt.toISOString(), status: "running" },
    ]);
    expect(run).toEqual({ id: "run-1", source: "clubspot-sync" });
  });

  it("returns undefined for a dry run's id-less echoed row", async () => {
    const createItems = vi.fn().mockResolvedValue([{ source: "clubspot-sync", started_at: "x", status: "running" }]);
    const directus = fakeDirectus({ createItems, isDryRun: true });

    const run = await startSyncRun(directus, "clubspot-sync", new Date());

    expect(run).toBeUndefined();
  });

  it("throws when a real run gets no id back", async () => {
    const createItems = vi.fn().mockResolvedValue([{ source: "clubspot-sync", started_at: "x", status: "running" }]);
    const directus = fakeDirectus({ createItems, isDryRun: false });

    await expect(startSyncRun(directus, "clubspot-sync", new Date())).rejects.toThrow(
      "Directus did not return the created sync_runs row",
    );
  });
});

describe("finishSyncRun", () => {
  it("patches the row with its outcome's status, counts, and error", async () => {
    const updateItem = vi.fn().mockResolvedValue({} as SyncRunRow);
    const directus = fakeDirectus({ updateItem });
    const finishedAt = new Date("2026-01-15T12:05:00Z");

    await finishSyncRun(directus, "run-1", finishedAt, {
      status: "failed",
      counts: { campsChecked: 3 },
      error: "camp sync failed",
    });

    expect(updateItem).toHaveBeenCalledWith("sync_runs", "run-1", {
      finished_at: finishedAt.toISOString(),
      status: "failed",
      counts: { campsChecked: 3 },
      error: "camp sync failed",
    });
  });

  it("writes a null error when the outcome carries none", async () => {
    const updateItem = vi.fn().mockResolvedValue({} as SyncRunRow);
    const directus = fakeDirectus({ updateItem });

    await finishSyncRun(directus, "run-1", new Date("2026-01-15T12:05:00Z"), {
      status: "succeeded",
      counts: { campsChecked: 3 },
    });

    expect(updateItem).toHaveBeenCalledWith(
      "sync_runs",
      "run-1",
      expect.objectContaining({ status: "succeeded", error: null }),
    );
  });
});
