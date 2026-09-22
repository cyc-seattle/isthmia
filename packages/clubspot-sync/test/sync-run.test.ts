import { describe, it, expect, vi, afterEach } from "vitest";
import type { Camp, CampClass, EntryCap, Registration } from "@cyc-seattle/clubspot-sdk";
import { DirectusClient, SyncQueue, SyncTaskRow } from "@cyc-seattle/directus";
import { PersonSync } from "../src/person-sync.js";
import { CampData, EPOCH, runSync, SyncGateway, syncOffering } from "../src/sync-run.js";

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
 * A stateful in-memory Directus stand-in: GET applies `_eq` filters (the only operator this
 * codebase's own queue and orchestration code issues) against a per-collection table that POST,
 * PATCH, and DELETE actually mutate. Good enough to exercise the queue's claim/enqueue cycle, which
 * a mock that merely echoes each call back (as clubspot-sync's collection passes only need) can't -
 * a claimed task has to still be there, and reflect its patch, on the next read.
 */
function makeDirectusStore(seed: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  const tables = new Map<string, Record<string, unknown>[]>(
    Object.entries(seed).map(([collection, rows]) => [collection, rows.map((row) => ({ ...row }))]),
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
      const match = /^filter\[([^\]]+)\]\[_eq\]$/.exec(key);
      if (match) {
        if (String(row[match[1]!] ?? "") !== value) {
          return false;
        }
      }
    }
    return true;
  }

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
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
      const index = rows.findIndex((row) => row.id === id);
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

describe("syncOffering", () => {
  it("creates a new offering from the epoch when there's no prior offering row", async () => {
    const { fetchMock } = makeDirectusStore();
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway();

    const theCamp = camp("camp-1");
    const outcome = await syncOffering({ camp: theCamp, directus, personSync: new PersonSync(directus), gateway });

    expect(outcome.status).toBe("synced");
    expect(gateway.fetchCampData).toHaveBeenCalledWith(theCamp, EPOCH, expect.any(Date));
  });

  it("is skipped, without fetching camp data, when the offering isn't due", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    // Synced five minutes ago with nothing written - due again in an hour, not now.
    const syncedThrough = new Date(now.getTime() - 5 * 60 * 1000);
    const { fetchMock, tables } = makeDirectusStore({
      offerings: [
        {
          id: "offering-1",
          clubspot_camp_id: "camp-1",
          name: "Camp",
          synced_through: syncedThrough.toISOString(),
          quiet_runs: 1,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway();

    const outcome = await syncOffering({
      camp: camp("camp-1"),
      directus,
      personSync: new PersonSync(directus),
      gateway,
    });

    expect(outcome).toEqual({ status: "skipped" });
    expect(gateway.fetchCampData).not.toHaveBeenCalled();
    expect(tables.get("offerings")![0]).toMatchObject({ synced_through: syncedThrough.toISOString(), quiet_runs: 1 });
  });

  it("bypasses the backoff check when asked, even when not due", async () => {
    const { fetchMock } = makeDirectusStore({
      offerings: [
        {
          id: "offering-1",
          clubspot_camp_id: "camp-1",
          name: "Camp",
          synced_through: new Date().toISOString(),
          quiet_runs: 0,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway();

    const outcome = await syncOffering({
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
      offerings: [
        {
          id: "offering-1",
          clubspot_camp_id: "camp-1",
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

    await syncOffering({ camp: theCamp, directus, personSync: new PersonSync(directus), gateway });

    expect(gateway.fetchCampData).toHaveBeenCalledWith(theCamp, watermark, now);
    expect(tables.get("offerings")![0]).toMatchObject({ synced_through: now.toISOString(), quiet_runs: 0 });
  });

  it("--since widens the read window without disturbing the stored watermark's role next run", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const since = new Date("2020-01-01T00:00:00Z");

    const { fetchMock } = makeDirectusStore({
      offerings: [
        {
          id: "offering-1",
          clubspot_camp_id: "camp-1",
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

    await syncOffering({
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
    // null, undefined), so this offering's own reconcile is a genuine no-op - the case this test needs.
    const { tables: quietTables, fetchMock: quietFetch } = makeDirectusStore({
      offerings: [
        {
          id: "offering-1",
          clubspot_camp_id: "camp-1",
          start_date: null,
          end_date: null,
          synced_through: null,
          quiet_runs: 2,
        },
      ],
    });
    vi.stubGlobal("fetch", quietFetch);
    const quietDirectus = new DirectusClient(baseUrl, token);
    await syncOffering({
      camp: camp("camp-1"),
      directus: quietDirectus,
      personSync: new PersonSync(quietDirectus),
      gateway: makeGateway(),
    });
    expect(quietTables.get("offerings")![0]).toMatchObject({ quiet_runs: 3 });
    vi.unstubAllGlobals();

    const { tables: activeTables, fetchMock: activeFetch } = makeDirectusStore({
      offerings: [{ id: "offering-1", clubspot_camp_id: "camp-1", name: "Camp", synced_through: null, quiet_runs: 2 }],
    });
    vi.stubGlobal("fetch", activeFetch);
    const activeDirectus = new DirectusClient(baseUrl, token);
    const writingGateway = makeGateway({
      fetchCampData: vi.fn(async (forCamp: Camp) => ({
        ...emptyCampData(forCamp),
        classes: [campClass("class-1", "camp-1", "Class One") as unknown as CampClass],
      })),
    });
    await syncOffering({
      camp: camp("camp-1"),
      directus: activeDirectus,
      personSync: new PersonSync(activeDirectus),
      gateway: writingGateway,
    });
    expect(activeTables.get("offerings")![0]).toMatchObject({ quiet_runs: 0 });
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

    const outcome = await syncOffering({
      camp: camp("camp-1"),
      directus,
      personSync: new PersonSync(directus),
      gateway,
    });

    expect(outcome).toMatchObject({ status: "synced", counts: { skipped: 1 } });
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
      offerings: [
        {
          id: "offering-1",
          clubspot_camp_id: "camp-1",
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
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit | undefined][]) {
      expect(init?.method ?? "GET").toBe("GET");
    }
  });

  it("--camp bypasses discovery and backoff, and --since widens the registration window", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const since = new Date("2020-01-01T00:00:00Z");
    const { fetchMock } = makeDirectusStore({
      offerings: [
        {
          id: "offering-1",
          clubspot_camp_id: "camp-1",
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
    expect(result).toMatchObject({ status: "ok", offeringsChecked: 1, offeringsFailed: 0 });
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
    expect(result).toMatchObject({ status: "failed", offeringsChecked: 2, offeringsFailed: 1 });
  });

  it("discovers camps, enqueues one sync_offering task per camp, and drains them through the queue", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { fetchMock, tables } = makeDirectusStore();
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway({ discoverCamps: vi.fn(async () => [camp("camp-a"), camp("camp-b")]) });

    const result = await runSync(runOptions(directus, now, gateway));

    expect(gateway.fetchCampData).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: "ok", offeringsChecked: 2, offeringsFailed: 0 });

    const tasks = tables.get("sync_tasks") ?? [];
    const runTask = tasks.find((task) => task.kind === "sync_run");
    expect(runTask).toMatchObject({ status: "done" });
    const offeringTasks = tasks.filter((task) => task.kind === "sync_offering");
    expect(offeringTasks).toHaveLength(2);
    expect(offeringTasks.every((task) => task.status === "done" && task.parent_id === runTask!.id)).toBe(true);
  });

  it("isolates one offering's failure from its sibling, through the queue", async () => {
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
    expect(result).toMatchObject({ status: "failed", offeringsChecked: 2, offeringsFailed: 1 });
    const tasks = (tables.get("sync_tasks") ?? []) as SyncTaskRow[];
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
    const runTask = (tables.get("sync_tasks") ?? []).find((task) => task.kind === "sync_run");
    expect(runTask).toMatchObject({ status: "failed", last_error: "discovery unavailable" });
  });

  it("promotes a winning custom field response onto people.school once, after the offering loop", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const { fetchMock, tables } = makeDirectusStore({
      offerings: [{ id: "offering-1", clubspot_camp_id: "camp-a", name: "Camp", synced_through: null, quiet_runs: 0 }],
      promoted_fields: [{ id: "config-1", target_field: "school", labels: ["School"] }],
      custom_field_definitions: [
        {
          id: "def-1",
          offering_id: "offering-1",
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
          offering_id: "offering-1",
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
    const gateway = makeGateway(); // no camps - isolates the promotion pass from the offering loop

    const result = await runSync(runOptions(directus, now, gateway));

    expect(result).toMatchObject({ status: "ok", peoplePromoted: 1 });
    expect(tables.get("people")![0]).toMatchObject({ school: "Roosevelt High" });
  });

  it("marks the run failed, without touching offering results, when the promotion pass throws", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    // Everything but promoted_fields goes through a real store; that one collection always errors,
    // isolating the promotion pass's own failure from the offering loop ahead of it.
    const { fetchMock: storeFetch, tables } = makeDirectusStore();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
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

    expect(result).toMatchObject({ status: "failed", offeringsChecked: 1, offeringsFailed: 0, peoplePromoted: 0 });
    const offeringTask = (tables.get("sync_tasks") ?? []).find((task) => task.kind === "sync_offering");
    expect(offeringTask?.status).toBe("done");
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
      offering_id: "offering-1",
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
      offerings: [{ id: "offering-1", clubspot_camp_id: "camp-a", name: "Camp", synced_through: null, quiet_runs: 0 }],
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
});
