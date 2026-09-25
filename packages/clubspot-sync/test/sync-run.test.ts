import { describe, it, expect, vi, afterEach } from "vitest";
import type { Camp, CampClass, EntryCap, Registration } from "@cyc-seattle/clubspot-sdk";
import { DirectusClient, SyncQueue, SyncRunRow, SyncTaskRow } from "@cyc-seattle/directus";
import { PersonSync } from "../src/person-sync.js";
import { CampData, EPOCH, runSync, SyncGateway, syncCamp } from "../src/sync-run.js";

// This package's tsconfig has no DOM lib, so the ambient `RequestInit` resolves to an empty
// structural type rather than undici's real one (see @cyc-seattle/directus's client.ts). This
// local alias covers the fields these tests assert on from a captured fetch-mock call.
type FetchInit = { method?: string; body?: unknown };

const baseUrl = "https://directus.example.com";
const token = "test-token";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/**
 * A stateful in-memory Directus stand-in: GET applies `_eq` and `_in` filters (the only operators
 * this codebase's own queue and orchestration code issues) against a per-collection table that
 * POST, PATCH, and DELETE actually mutate. Good enough to exercise the queue's claim/enqueue cycle,
 * which a mock that merely echoes each call back (as clubspot-sync's collection passes only need)
 * can't - a claimed task has to still be there, and reflect its patch, on the next read.
 */
function makeDirectusStore(seed: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  const tables = new Map<string, Record<string, unknown>[]>(
    Object.entries(seed).map(([collection, rows]) => [collection, (rows ?? []).map((row) => ({ ...row }))]),
  );
  let nextId = 1;

  function table(collection: string): Record<string, unknown>[] {
    if (!tables.has(collection)) {
      tables.set(collection, []);
    }
    return tables.get(collection)!;
  }

  function matchesFilter(row: Record<string, unknown>, search: URLSearchParams): boolean {
    for (const [key, value] of search.entries()) {
      const eqMatch = /^filter\[([^\]]+)\]\[_eq\]$/.exec(key);
      if (eqMatch) {
        if (String(row[eqMatch[1]!] ?? "") !== value) {
          return false;
        }
        continue;
      }
      const inMatch = /^filter\[([^\]]+)\]\[_in\]$/.exec(key);
      if (inMatch) {
        if (!value.split(",").includes(String(row[inMatch[1]!] ?? ""))) {
          return false;
        }
      }
    }
    return true;
  }

  const fetchMock = vi.fn(async (url: string, init?: FetchInit) => {
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    const [, , collection, id] = parsed.pathname.split("/");

    if (method === "GET") {
      const rows = table(collection!).filter((row) => matchesFilter(row, parsed.searchParams));
      return jsonResponse(200, { data: rows });
    }
    if (method === "POST") {
      const items = JSON.parse(init!.body as string) as Record<string, unknown>[];
      const created = items.map((item) => ({ id: `generated-${nextId++}`, ...item }));
      table(collection!).push(...created);
      return jsonResponse(200, { data: created });
    }
    if (method === "PATCH") {
      const patch = JSON.parse(init!.body as string) as Record<string, unknown>;
      const rows = table(collection!);
      const index = rows.findIndex((row) => row["id"] === id);
      if (index === -1) {
        return jsonResponse(200, { data: patch });
      }
      rows[index] = { ...rows[index], ...patch };
      return jsonResponse(200, { data: rows[index] });
    }
    return jsonResponse(204, undefined);
  });

  return { fetchMock, tables };
}

// Minimal Parse.Object stand-in: an id and a `.get(key)` accessor, per roster.test.ts.
function camp(id: string): Camp {
  return { id, get: () => undefined } as unknown as Camp;
}

function parseObject(id: string, data: Record<string, unknown>) {
  return { id, get: (key: string) => data[key] };
}

function campClass(id: string, campId: string, name: string) {
  return parseObject(id, { campObject: { id: campId }, name });
}

function entryCap(id: string, classId: string, cap: number, sessionId?: string) {
  return parseObject(id, {
    campClassObject: { id: classId },
    campSessionObject: sessionId ? { id: sessionId } : undefined,
    cap,
  });
}

// The in-memory store keeps every table as loosely typed rows; the code under test always writes
// sync_tasks rows matching the real schema, so asserting on them as SyncTaskRow is safe here.
function asSyncTasks(rows: Record<string, unknown>[]): SyncTaskRow[] {
  return rows as unknown as SyncTaskRow[];
}

// Same reasoning as asSyncTasks: the code under test always writes sync_runs rows matching the
// real schema.
function asSyncRuns(rows: Record<string, unknown>[]): SyncRunRow[] {
  return rows as unknown as SyncRunRow[];
}

function emptyCampData(forCamp: Camp): CampData {
  return { camp: forCamp, classes: [], sessions: [], entryCaps: [], registrations: [] };
}

function makeGateway(overrides: Partial<SyncGateway> = {}): SyncGateway {
  return {
    discoverCamps: vi.fn(async () => []),
    getCamp: vi.fn(async (id: string) => camp(id)),
    fetchCampData: vi.fn(async (forCamp: Camp) => emptyCampData(forCamp)),
    ...overrides,
  };
}

describe("syncCamp", () => {
  it("creates a new camp from the epoch when there's no prior camp row", async () => {
    const { fetchMock } = makeDirectusStore();
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway();

    const theCamp = camp("camp-1");
    const outcome = await syncCamp({ camp: theCamp, directus, personSync: new PersonSync(directus), gateway });

    expect(outcome.status).toBe("synced");
    expect(gateway.fetchCampData).toHaveBeenCalledWith(theCamp, EPOCH, expect.any(Date));
  });

  it("is skipped, without fetching camp data, when the camp isn't due", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // Synced five minutes ago with nothing written - due again in an hour, not now.
    const syncedThrough = new Date(now.getTime() - 5 * 60 * 1000);
    const { fetchMock, tables } = makeDirectusStore({
      camps: [
        {
          id: "camp-row-1",
          clubspot_camp_id: "camp-1",
          clubspot_sales_account: null,
          name: "Camp",
          synced_through: syncedThrough.toISOString(),
          quiet_runs: 1,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway();

    const outcome = await syncCamp({
      camp: camp("camp-1"),
      directus,
      personSync: new PersonSync(directus),
      gateway,
    });

    expect(outcome).toEqual({ status: "skipped" });
    expect(gateway.fetchCampData).not.toHaveBeenCalled();
    expect(tables.get("camps")![0]).toMatchObject({ synced_through: syncedThrough.toISOString(), quiet_runs: 1 });
  });

  it("bypasses the backoff check when asked, even when not due", async () => {
    const { fetchMock } = makeDirectusStore({
      camps: [
        {
          id: "camp-row-1",
          clubspot_camp_id: "camp-1",
          clubspot_sales_account: null,
          name: "Camp",
          synced_through: new Date().toISOString(),
          quiet_runs: 0,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway();

    const outcome = await syncCamp({
      camp: camp("camp-1"),
      bypassBackoff: true,
      directus,
      personSync: new PersonSync(directus),
      gateway,
    });

    expect(outcome.status).toBe("synced");
    expect(gateway.fetchCampData).toHaveBeenCalled();
  });

  it("uses the stored watermark, and advances it to this sync's own start", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const watermark = new Date("2026-01-01T00:00:00Z");

    const { fetchMock, tables } = makeDirectusStore({
      camps: [
        {
          id: "camp-row-1",
          clubspot_camp_id: "camp-1",
          clubspot_sales_account: null,
          name: "Camp",
          synced_through: watermark.toISOString(),
          quiet_runs: 3,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway();
    const theCamp = camp("camp-1");

    await syncCamp({ camp: theCamp, directus, personSync: new PersonSync(directus), gateway });

    expect(gateway.fetchCampData).toHaveBeenCalledWith(theCamp, watermark, now);
    expect(tables.get("camps")![0]).toMatchObject({ synced_through: now.toISOString(), quiet_runs: 0 });
  });

  it("--since widens the read window without disturbing the stored watermark's role next run", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const since = new Date("2020-01-01T00:00:00Z");

    const { fetchMock } = makeDirectusStore({
      camps: [
        {
          id: "camp-row-1",
          clubspot_camp_id: "camp-1",
          clubspot_sales_account: null,
          name: "Camp",
          synced_through: "2026-01-14T00:00:00.000Z",
          quiet_runs: 0,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway();
    const theCamp = camp("camp-1");

    await syncCamp({
      camp: theCamp,
      since,
      bypassBackoff: true,
      directus,
      personSync: new PersonSync(directus),
      gateway,
    });

    expect(gateway.fetchCampData).toHaveBeenCalledWith(theCamp, since, now);
  });

  it("increments quiet_runs when the sync writes nothing, and resets it when it writes something", async () => {
    // start_date/end_date/name match what the bare `camp()` stub's schedule plan derives (null,
    // null, undefined), so this camp's own reconcile is a genuine no-op - the case this test needs.
    const { tables: quietTables, fetchMock: quietFetch } = makeDirectusStore({
      camps: [
        {
          id: "camp-row-1",
          clubspot_camp_id: "camp-1",
          clubspot_sales_account: null,
          start_date: null,
          end_date: null,
          synced_through: null,
          quiet_runs: 2,
        },
      ],
    });
    vi.stubGlobal("fetch", quietFetch);
    const quietDirectus = new DirectusClient(baseUrl, token);
    await syncCamp({
      camp: camp("camp-1"),
      directus: quietDirectus,
      personSync: new PersonSync(quietDirectus),
      gateway: makeGateway(),
    });
    expect(quietTables.get("camps")![0]).toMatchObject({ quiet_runs: 3 });
    vi.unstubAllGlobals();

    const { tables: activeTables, fetchMock: activeFetch } = makeDirectusStore({
      camps: [
        {
          id: "camp-row-1",
          clubspot_camp_id: "camp-1",
          clubspot_sales_account: null,
          name: "Camp",
          synced_through: null,
          quiet_runs: 2,
        },
      ],
    });
    vi.stubGlobal("fetch", activeFetch);
    const activeDirectus = new DirectusClient(baseUrl, token);
    const writingGateway = makeGateway({
      fetchCampData: vi.fn(async (forCamp: Camp) => ({
        ...emptyCampData(forCamp),
        classes: [campClass("class-1", "camp-1", "Class One") as unknown as CampClass],
      })),
    });
    await syncCamp({
      camp: camp("camp-1"),
      directus: activeDirectus,
      personSync: new PersonSync(activeDirectus),
      gateway: writingGateway,
    });
    expect(activeTables.get("camps")![0]).toMatchObject({ quiet_runs: 0 });
  });

  it("records items_skipped-equivalent counts by still syncing when an entry cap references an unresolvable session", async () => {
    const { fetchMock } = makeDirectusStore();
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway({
      fetchCampData: vi.fn(async (forCamp: Camp) => ({
        ...emptyCampData(forCamp),
        classes: [campClass("class-1", "camp-1", "Class One") as unknown as CampClass],
        entryCaps: [entryCap("cap-1", "class-1", 5, "session-missing") as unknown as EntryCap],
      })),
    });

    const outcome = await syncCamp({
      camp: camp("camp-1"),
      directus,
      personSync: new PersonSync(directus),
      gateway,
    });

    expect(outcome).toMatchObject({ status: "synced", counts: { skipped: 1 } });
  });

  it("scopes the read to the camp being synced without dropping that camp's own existing rows", async () => {
    // Two camps, each with a class and an entry cap already synced. Only camp-a is due; if its
    // scoped read missed cap-a1 (say, by scoping entry_caps to the wrong camp's classes), the
    // plan would see no existing row and create a duplicate instead of reconciling in place.
    const { fetchMock, tables } = makeDirectusStore({
      camps: [
        {
          id: "camp-row-1",
          clubspot_camp_id: "camp-a",
          clubspot_sales_account: null,
          name: "Camp A",
          start_date: null,
          end_date: null,
          synced_through: null,
          quiet_runs: 0,
        },
        {
          id: "camp-row-2",
          clubspot_camp_id: "camp-b",
          clubspot_sales_account: null,
          name: "Camp B",
          start_date: null,
          end_date: null,
          synced_through: null,
          quiet_runs: 0,
        },
      ],
      classes: [
        { id: "class-a1", camp_id: "camp-row-1", name: "Class A1", clubspot_class_id: "class-a1" },
        { id: "class-b1", camp_id: "camp-row-2", name: "Class B1", clubspot_class_id: "class-b1" },
      ],
      entry_caps: [
        { id: "cap-a1", class_id: "class-a1", session_id: null, cap: 10, clubspot_entry_cap_id: "cap-a1" },
        { id: "cap-b1", class_id: "class-b1", session_id: null, cap: 5, clubspot_entry_cap_id: "cap-b1" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const theCamp = parseObject("camp-a", { name: "Camp A" }) as unknown as Camp;
    const gateway = makeGateway({
      fetchCampData: vi.fn(async () => ({
        camp: theCamp,
        classes: [campClass("class-a1", "camp-a", "Class A1") as unknown as CampClass],
        sessions: [],
        entryCaps: [entryCap("cap-a1", "class-a1", 10) as unknown as EntryCap],
        registrations: [],
      })),
    });

    const outcome = await syncCamp({ camp: theCamp, directus, personSync: new PersonSync(directus), gateway });

    expect(outcome).toMatchObject({ status: "synced", counts: { created: 0, updated: 0, skipped: 0 } });
    expect(tables.get("classes")).toHaveLength(2);
    expect(tables.get("entry_caps")).toHaveLength(2);
    expect(tables.get("entry_caps")).toContainEqual(expect.objectContaining({ id: "cap-a1", cap: 10 }));
    // The sibling camp's rows are untouched, proving the scope excluded rather than merely ignored them.
    expect(tables.get("classes")).toContainEqual(expect.objectContaining({ id: "class-b1", camp_id: "camp-row-2" }));
    expect(tables.get("entry_caps")).toContainEqual(expect.objectContaining({ id: "cap-b1", class_id: "class-b1" }));
  });

  it("chunks the registration-hop _in filter so no single request's URL grows unbounded", async () => {
    // A big camp used to fail with a URL too long for a comma-joined `_in` list of every
    // registration id in one request (production: two of forty camps, hundreds of
    // registrations each). The fix batches the `_in` list instead - each request's URL must stay
    // bounded regardless of how many registrations the camp has, at the cost of more requests.
    async function registrationEntriesRequests(registrationCount: number) {
      const registrations = Array.from({ length: registrationCount }, (_, index) => ({
        // UUID-shaped, like the real ids readByIds batches in production.
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        clubspot_registration_id: `reg-${index}`,
        person_id: "person-1",
        camp_id: "camp-row-1",
        registered_at: "2026-01-01T00:00:00Z",
        status: "confirmed",
        waiver_status: null,
        archived: false,
        clubspot_participant_id: null,
      }));
      const { fetchMock } = makeDirectusStore({
        camps: [
          {
            id: "camp-row-1",
            clubspot_camp_id: "camp-1",
            clubspot_sales_account: null,
            name: "Camp",
            start_date: null,
            end_date: null,
            synced_through: null,
            quiet_runs: 0,
          },
        ],
        registrations,
      });
      vi.stubGlobal("fetch", fetchMock);
      const directus = new DirectusClient(baseUrl, token);
      await syncCamp({
        camp: camp("camp-1"),
        directus,
        personSync: new PersonSync(directus),
        gateway: makeGateway(),
      });
      vi.unstubAllGlobals();

      return (fetchMock.mock.calls as [string, FetchInit | undefined][])
        .map(([url]) => new URL(url))
        .filter((url) => url.pathname === "/items/registration_entries");
    }

    const withFew = await registrationEntriesRequests(3);
    const withMany = await registrationEntriesRequests(200);

    expect(withFew).toHaveLength(1);
    // 200 registrations at 40 ids/batch is 5 requests, not one url that keeps growing.
    expect(withMany).toHaveLength(5);

    for (const request of [...withFew, ...withMany]) {
      const ids = request.searchParams.get("filter[registration_id][_in]")!.split(",");
      expect(ids.length).toBeLessThanOrEqual(40);
      expect(request.toString().length).toBeLessThan(2000);
    }
  });
});

function runOptions(directus: DirectusClient, now: Date, gateway: SyncGateway) {
  return {
    clubId: "club-1",
    now,
    directus,
    queue: new SyncQueue(directus),
    personSync: new PersonSync(directus),
    gateway,
  };
}

describe("runSync", () => {
  it("in dry-run mode with full discovery, respects backoff and issues only reads", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { fetchMock } = makeDirectusStore({
      camps: [
        {
          id: "camp-row-1",
          clubspot_camp_id: "camp-1",
          clubspot_sales_account: null,
          name: "Camp",
          synced_through: now.toISOString(),
          quiet_runs: 0,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token, true);
    const gateway = makeGateway({ discoverCamps: vi.fn(async () => [camp("camp-1")]) });

    const result = await runSync(runOptions(directus, now, gateway));

    expect(result.status).toBe("ok");
    expect(gateway.fetchCampData).not.toHaveBeenCalled();
    for (const [, init] of fetchMock.mock.calls as [string, FetchInit | undefined][]) {
      expect(init?.method ?? "GET").toBe("GET");
    }
  });

  it("--camp bypasses discovery and backoff, and --since widens the registration window", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const since = new Date("2020-01-01T00:00:00Z");
    const { fetchMock } = makeDirectusStore({
      camps: [
        {
          id: "camp-row-1",
          clubspot_camp_id: "camp-1",
          clubspot_sales_account: null,
          name: "Camp",
          synced_through: now.toISOString(), // backed all the way off - would never be due on its own
          quiet_runs: 10,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const theCamp = camp("camp-1");
    const gateway = makeGateway({ getCamp: vi.fn(async () => theCamp) });

    const result = await runSync({ ...runOptions(directus, now, gateway), campId: "camp-1", since });

    expect(gateway.fetchCampData).toHaveBeenCalledWith(theCamp, since, expect.any(Date));
    expect(result).toMatchObject({ status: "ok", campsChecked: 1, campsFailed: 0 });
  });

  it("continues past one camp's failure to the next, in the direct (dry-run/--camp) path", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { fetchMock } = makeDirectusStore();
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token, true);
    const gateway = makeGateway({
      discoverCamps: vi.fn(async () => [camp("camp-a"), camp("camp-b")]),
      fetchCampData: vi.fn(async (forCamp: Camp) => {
        if (forCamp.id === "camp-a") {
          throw new Error("boom");
        }
        return emptyCampData(forCamp);
      }),
    });

    const result = await runSync(runOptions(directus, now, gateway));

    expect(gateway.fetchCampData).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "failed", campsChecked: 2, campsFailed: 1 });
  });

  it("discovers camps, enqueues one sync_camp task per camp, and drains them through the queue", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { fetchMock, tables } = makeDirectusStore();
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway({ discoverCamps: vi.fn(async () => [camp("camp-a"), camp("camp-b")]) });

    const result = await runSync(runOptions(directus, now, gateway));

    expect(gateway.fetchCampData).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "ok", campsChecked: 2, campsFailed: 0 });

    const tasks = asSyncTasks(tables.get("sync_tasks") ?? []);
    const runTask = tasks.find((task) => task.kind === "sync_run");
    expect(runTask).toMatchObject({ status: "done" });
    const campTasks = tasks.filter((task) => task.kind === "sync_camp");
    expect(campTasks).toHaveLength(2);
    expect(campTasks.every((task) => task.status === "done" && task.parent_id === runTask!.id)).toBe(true);
  });

  it("isolates one camp's failure from its sibling, through the queue", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { fetchMock, tables } = makeDirectusStore();
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway({
      discoverCamps: vi.fn(async () => [camp("camp-a"), camp("camp-b")]),
      fetchCampData: vi.fn(async (forCamp: Camp) => {
        if (forCamp.id === "camp-a") {
          throw new Error("boom");
        }
        return emptyCampData(forCamp);
      }),
    });

    const result = await runSync(runOptions(directus, now, gateway));

    // camp-b still gets synced despite camp-a's task failing - the isolation the queue exists for.
    expect(result).toMatchObject({ status: "failed", campsChecked: 2, campsFailed: 1 });
    const tasks = asSyncTasks(tables.get("sync_tasks") ?? []);
    const campBTask = tasks.find((task) => task.key.endsWith("camp-b"));
    expect(campBTask?.status).toBe("done");
    const campATask = tasks.find((task) => task.key.endsWith("camp-a"));
    expect(campATask?.status).not.toBe("done");
    expect(campATask?.last_error).toBe("boom");
  });

  it("still reports the run failed, with the discovery error, when camp discovery itself throws", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { fetchMock, tables } = makeDirectusStore();
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway({
      discoverCamps: vi.fn(async () => {
        throw new Error("discovery unavailable");
      }),
    });

    const result = await runSync(runOptions(directus, now, gateway));

    expect(result.status).toBe("failed");
    const runTask = asSyncTasks(tables.get("sync_tasks") ?? []).find((task) => task.kind === "sync_run");
    expect(runTask).toMatchObject({ status: "failed", last_error: "discovery unavailable" });
  });

  // The regression test for #143 finding 4: sync_run keeps a stable key, so every run's children
  // land on the same parent row. Before the fix, campsFailed was computed by reading every task
  // ever attached to that parent, so camp-a's task - left non-"done" by its one failed attempt -
  // kept the run permanently "failed" even after Clubspot stopped offering camp-a up for discovery.
  it("stops counting a camp's failed task once it's archived and discovery no longer returns it", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { fetchMock, tables } = makeDirectusStore();
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway({
      discoverCamps: vi.fn(async () => [camp("camp-a"), camp("camp-b")]),
      fetchCampData: vi.fn(async (forCamp: Camp) => {
        if (forCamp.id === "camp-a") {
          throw new Error("boom");
        }
        return emptyCampData(forCamp);
      }),
    });

    const first = await runSync(runOptions(directus, now, gateway));
    expect(first).toMatchObject({ status: "failed", campsChecked: 2, campsFailed: 1 });

    // camp-a is archived in Clubspot: discovery stops returning it, so its still-pending task is
    // never re-enqueued or reset, but the row stays attached to the sync_run parent's stable key.
    gateway.discoverCamps = vi.fn(async () => [camp("camp-b")]);
    const second = await runSync(runOptions(directus, now, gateway));

    expect(second).toMatchObject({ status: "ok", campsChecked: 1, campsFailed: 0 });
    const campATask = asSyncTasks(tables.get("sync_tasks") ?? []).find((task) => task.key.endsWith("camp-a"));
    expect(campATask?.status).toBe("pending");
  });

  it("cancels, rather than fails, a sync_camp task whose camp no longer exists in Clubspot", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { fetchMock, tables } = makeDirectusStore();
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway({
      discoverCamps: vi.fn(async () => [camp("camp-a")]),
      getCamp: vi.fn(async () => {
        throw new Error("Object not found.");
      }),
    });

    const result = await runSync(runOptions(directus, now, gateway));

    expect(result).toMatchObject({ status: "ok", campsChecked: 1, campsFailed: 0 });
    const campTask = asSyncTasks(tables.get("sync_tasks") ?? []).find((task) => task.kind === "sync_camp");
    expect(campTask).toMatchObject({ status: "cancelled" });
  });

  it("promotes a winning custom field response onto people.school once, after the camp loop", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { fetchMock, tables } = makeDirectusStore({
      camps: [
        {
          id: "camp-row-1",
          clubspot_camp_id: "camp-a",
          clubspot_sales_account: null,
          name: "Camp",
          synced_through: null,
          quiet_runs: 0,
        },
      ],
      promoted_fields: [{ id: "config-1", target_field: "school", labels: ["School"] }],
      custom_field_definitions: [
        {
          id: "def-1",
          camp_id: "camp-row-1",
          label: "School",
          field_type: "text",
          required: false,
          clubspot_custom_field_id: "def-1",
        },
      ],
      custom_field_responses: [
        { id: "resp-1", registration_id: "reg-row-1", definition_id: "def-1", value: "Roosevelt High" },
      ],
      registrations: [
        {
          id: "reg-row-1",
          person_id: "person-1",
          camp_id: "camp-row-1",
          clubspot_registration_id: "reg-1",
          registered_at: "2026-01-01T00:00:00Z",
          status: "confirmed",
          waiver_status: null,
          archived: false,
          clubspot_participant_id: null,
        },
      ],
      people: [
        {
          id: "person-1",
          first_name: "Jane",
          last_name: "Doe",
          email: null,
          phone: null,
          date_of_birth: null,
          gender: null,
          street: null,
          city: null,
          state: null,
          postal_code: null,
          school: null,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway(); // no camps - isolates the promotion pass from the camp loop

    const result = await runSync(runOptions(directus, now, gateway));

    expect(result).toMatchObject({ status: "ok", peoplePromoted: 1 });
    expect(tables.get("people")![0]).toMatchObject({ school: "Roosevelt High" });
  });

  it("marks the run failed, without touching camp results, when the promotion pass throws", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    // Everything but promoted_fields goes through a real store; that one collection always errors,
    // isolating the promotion pass's own failure from the camp loop ahead of it.
    const { fetchMock: storeFetch, tables } = makeDirectusStore();
    const fetchMock = vi.fn(async (url: string, init?: FetchInit) => {
      const method = init?.method ?? "GET";
      const collection = new URL(url).pathname.split("/")[2];
      if (method === "GET" && collection === "promoted_fields") {
        return jsonResponse(500, { error: "promoted_fields unavailable" });
      }
      return storeFetch(url, init);
    });
    vi.stubGlobal("fetch", fetchMock);

    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway({ discoverCamps: vi.fn(async () => [camp("camp-a")]) });

    const result = await runSync(runOptions(directus, now, gateway));

    expect(result).toMatchObject({ status: "failed", campsChecked: 1, campsFailed: 0, peoplePromoted: 0 });
    const campTask = asSyncTasks(tables.get("sync_tasks") ?? []).find((task) => task.kind === "sync_camp");
    expect(campTask?.status).toBe("done");
  });

  // The regression test for finding 3: `registrations` already has a row for reg-1, pointing at
  // person-1. Its participant's name below has since been corrected in Clubspot, which is exactly
  // the case that made a fresh match choose - or create - a different person. The sync must reuse
  // person-1 instead of re-matching.
  it("reuses an existing registration's person_id for its participant, without re-matching", async () => {
    const now = new Date("2026-01-15T12:00:00Z");

    const existingRegistrationRow = {
      id: "reg-row-1",
      clubspot_registration_id: "reg-1",
      person_id: "person-1",
      camp_id: "camp-row-1",
      registered_at: "2026-01-01T00:00:00.000Z",
      status: "confirmed",
      waiver_status: null,
      archived: false,
      clubspot_participant_id: "participant-1",
    };

    const registration = parseObject("reg-1", {
      campObject: { id: "camp-a" },
      participantsArray: [parseObject("participant-1", { firstName: "John", lastName: "Smith" })],
      confirmed_at: new Date("2026-01-10T00:00:00Z"),
      status: "confirmed",
      waiver_status: "fully_signed",
      archived: false,
    }) as unknown as Registration;

    const { fetchMock } = makeDirectusStore({
      camps: [
        {
          id: "camp-row-1",
          clubspot_camp_id: "camp-a",
          clubspot_sales_account: null,
          name: "Camp",
          synced_through: null,
          quiet_runs: 0,
        },
      ],
      registrations: [existingRegistrationRow],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);

    const gateway = makeGateway({
      discoverCamps: vi.fn(async () => [camp("camp-a")]),
      fetchCampData: vi.fn(async (forCamp: Camp) => ({ ...emptyCampData(forCamp), registrations: [registration] })),
    });

    const syncSpy = vi.spyOn(PersonSync.prototype, "syncParticipant");
    try {
      await runSync(runOptions(directus, now, gateway));
      expect(syncSpy).toHaveBeenCalledWith(expect.anything(), "person-1");
    } finally {
      syncSpy.mockRestore();
    }
  });

  describe("its sync_runs row", () => {
    it("creates then finishes the row as succeeded, with counts, on a successful run", async () => {
      const now = new Date("2026-01-15T12:00:00Z");
      const { fetchMock, tables } = makeDirectusStore();
      vi.stubGlobal("fetch", fetchMock);
      const directus = new DirectusClient(baseUrl, token);
      const gateway = makeGateway({ discoverCamps: vi.fn(async () => [camp("camp-a")]) });

      const result = await runSync(runOptions(directus, now, gateway));

      expect(result).toMatchObject({ status: "ok", campsChecked: 1, campsFailed: 0, peoplePromoted: 0 });
      const runs = asSyncRuns(tables.get("sync_runs") ?? []);
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        source: "clubspot-sync",
        started_at: now.toISOString(),
        status: "succeeded",
        counts: { campsChecked: 1, campsFailed: 0, peoplePromoted: 0 },
        error: null,
      });
      expect(runs[0]!.finished_at).toBeTruthy();
      expect(result.syncRunId).toBe(runs[0]!.id);
    });

    it("finishes the row as failed, with the error, when a camp fails", async () => {
      const now = new Date("2026-01-15T12:00:00Z");
      const { fetchMock, tables } = makeDirectusStore();
      vi.stubGlobal("fetch", fetchMock);
      const directus = new DirectusClient(baseUrl, token);
      const gateway = makeGateway({
        discoverCamps: vi.fn(async () => {
          throw new Error("discovery unavailable");
        }),
      });

      const result = await runSync(runOptions(directus, now, gateway));

      expect(result.status).toBe("failed");
      const runs = asSyncRuns(tables.get("sync_runs") ?? []);
      expect(runs[0]).toMatchObject({ status: "failed", error: "discovery unavailable" });
    });

    it("writes nothing on a dry run, and doesn't throw", async () => {
      const now = new Date("2026-01-15T12:00:00Z");
      const { fetchMock, tables } = makeDirectusStore();
      vi.stubGlobal("fetch", fetchMock);
      const directus = new DirectusClient(baseUrl, token, true);
      const gateway = makeGateway({ discoverCamps: vi.fn(async () => [camp("camp-a")]) });

      const result = await runSync(runOptions(directus, now, gateway));

      expect(result.status).toBe("ok");
      expect(result.syncRunId).toBeUndefined();
      expect(tables.get("sync_runs") ?? []).toHaveLength(0);
    });
  });
});
