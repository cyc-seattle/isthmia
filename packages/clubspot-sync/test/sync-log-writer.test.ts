import { describe, it, expect, vi, afterEach } from "vitest";
import { DirectusClient } from "../src/directus.js";
import { SyncLog } from "../src/sync-log.js";

const baseUrl = "https://directus.example.com";
const token = "test-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

describe("SyncLog", () => {
  it("starts a run with status running and zeroed counters", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "run-1" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const log = new SyncLog(new DirectusClient(baseUrl, token));

    await log.startRun(new Date("2026-01-15T12:00:00Z"));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/items/sync_runs`);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual([
      {
        started_at: "2026-01-15T12:00:00.000Z",
        status: "running",
        programs_checked: 0,
        programs_synced: 0,
        programs_skipped: 0,
        programs_failed: 0,
      },
    ]);
  });

  it("finishes a run with the final status and counts", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    vi.stubGlobal("fetch", fetchMock);
    const log = new SyncLog(new DirectusClient(baseUrl, token));

    await log.finishRun("run-1", new Date("2026-01-15T12:05:00Z"), {
      status: "ok",
      programsChecked: 10,
      programsSynced: 3,
      programsSkipped: 2,
      programsFailed: 0,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/items/sync_runs/run-1`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({
      finished_at: "2026-01-15T12:05:00.000Z",
      status: "ok",
      programs_checked: 10,
      programs_synced: 3,
      programs_skipped: 2,
      programs_failed: 0,
      error: null,
    });
  });

  it("records a program run row for a camp with no programs row yet", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "spr-1" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const log = new SyncLog(new DirectusClient(baseUrl, token));

    await log.recordProgramRun({
      run_id: "run-1",
      program_id: null,
      clubspot_camp_id: "clubspot-camp-1",
      started_at: "2026-01-15T12:00:00.000Z",
      finished_at: "2026-01-15T12:00:05.000Z",
      status: "ok",
      items_created: 2,
      items_updated: 0,
      items_skipped: 0,
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${baseUrl}/items/sync_program_runs`);
    const [body] = JSON.parse(init.body as string) as [Record<string, unknown>];
    expect(body).toMatchObject({ clubspot_camp_id: "clubspot-camp-1", program_id: null, status: "ok" });
  });
});
