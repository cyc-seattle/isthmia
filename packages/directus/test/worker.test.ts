import { describe, it, expect, vi, afterEach } from "vitest";
import { DirectusClient } from "../src/client.js";
import { runQueue, SyncQueue } from "../src/worker.js";
import { SyncTaskRow } from "../src/sync-tasks.js";

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

describe("SyncQueue.enqueue", () => {
  it("creates a new row when no task with this key exists", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [] })) // lookup by key
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "task-1" }] })); // create
    vi.stubGlobal("fetch", fetchMock);
    const queue = new SyncQueue(new DirectusClient(baseUrl, token));

    await queue.enqueue(
      { queue: "clubspot-sync", kind: "sync_offering", target: "offering-1" },
      new Date("2026-01-15T12:00:00Z"),
    );

    const [createUrl, createInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(createUrl).toBe(`${baseUrl}/items/sync_tasks`);
    expect(createInit.method).toBe("POST");
    const [body] = JSON.parse(createInit.body as string) as [Record<string, unknown>];
    expect(body).toMatchObject({
      queue: "clubspot-sync",
      kind: "sync_offering",
      key: "clubspot-sync:sync_offering:offering-1",
      status: "pending",
    });
  });

  it("updates the existing row with this key instead of creating a duplicate", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "task-1", key: "offering-1" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { id: "task-1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const queue = new SyncQueue(new DirectusClient(baseUrl, token));

    await queue.enqueue(
      { queue: "clubspot-sync", kind: "sync_offering", target: "offering-1" },
      new Date("2026-01-15T12:00:00Z"),
    );

    const [updateUrl, updateInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(updateUrl).toBe(`${baseUrl}/items/sync_tasks/task-1`);
    expect(updateInit.method).toBe("PATCH");
  });
});

describe("runQueue", () => {
  const dueTask: SyncTaskRow = {
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
  };

  it("claims a due task, runs its handler, and marks it done", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [dueTask] })) // read claimable
      .mockResolvedValueOnce(jsonResponse(200, { data: { ...dueTask, status: "running", attempts: 1 } })) // claim
      .mockResolvedValueOnce(jsonResponse(200, { data: { ...dueTask, status: "done" } })) // success
      .mockResolvedValueOnce(jsonResponse(200, { data: [] })); // no more claimable tasks
    vi.stubGlobal("fetch", fetchMock);
    const handler = vi.fn().mockResolvedValue(undefined);

    const result = await runQueue(new DirectusClient(baseUrl, token), "clubspot-sync", { sync_offering: handler });

    expect(result.processed).toBe(1);
    expect(handler).toHaveBeenCalledOnce();
    const [, claimInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(claimInit.body as string)).toMatchObject({ status: "running", attempts: 1 });
    const [, successInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(successInit.body as string)).toMatchObject({ status: "done" });
  });

  it("marks a task pending with backoff when its handler throws and attempts remain", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: [dueTask] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ...dueTask, status: "running", attempts: 1 } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ...dueTask, status: "pending" } }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const handler = vi.fn().mockRejectedValue(new Error("clubspot is down"));

    await runQueue(new DirectusClient(baseUrl, token), "clubspot-sync", { sync_offering: handler });

    const [, failureInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(failureInit.body as string)).toMatchObject({ status: "pending", last_error: "clubspot is down" });
  });

  it("throws when a claimable task's kind has no registered handler, without claiming it", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: [dueTask] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runQueue(new DirectusClient(baseUrl, token), "clubspot-sync", {})).rejects.toThrow(
      /No handler registered for sync_tasks kind "sync_offering"/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
