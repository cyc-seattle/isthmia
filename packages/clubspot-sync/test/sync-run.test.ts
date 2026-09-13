import { describe, it, expect, vi, afterEach } from "vitest";
import type { Camp, Registration } from "@cyc-seattle/clubspot-sdk";
import { ChildCounts } from "../src/change-detection.js";
import { DirectusClient } from "../src/directus.js";
import { PersonSync } from "../src/person-sync.js";
import { SyncLog } from "../src/sync-log.js";
import { CampData, runSync, SyncGateway } from "../src/sync-run.js";

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

/**
 * A minimal in-memory Directus stand-in: GET returns seeded rows for a collection, POST echoes
 * the posted rows back with a generated id, PATCH echoes the patch, DELETE returns 204. Good
 * enough for exercising the orchestration in sync-run.ts without asserting on every call.
 */
function makeFetchMock(seed: Partial<Record<string, unknown[]>> = {}) {
  let nextId = 1;
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const collection = new URL(url).pathname.split("/")[2];

    if (method === "GET") {
      return jsonResponse(200, { data: seed[collection!] ?? [] });
    }
    if (method === "POST") {
      const items = JSON.parse(init!.body as string) as Record<string, unknown>[];
      return jsonResponse(200, { data: items.map((item) => ({ id: `generated-${nextId++}`, ...item })) });
    }
    if (method === "PATCH") {
      return jsonResponse(200, { data: JSON.parse(init!.body as string) });
    }
    return jsonResponse(204, undefined);
  });
}

// Minimal Parse.Object stand-in: an id, a `.get(key)` accessor, and `updatedAt`, per roster.test.ts.
function camp(id: string, updatedAt: Date): Camp {
  return { id, get: () => undefined, updatedAt } as unknown as Camp;
}

// Minimal Parse.Object stand-in with no `updatedAt`, per registrations.test.ts.
function parseObject(id: string, data: Record<string, unknown>) {
  return { id, get: (key: string) => data[key] };
}

function emptyCampData(forCamp: Camp): CampData {
  return { camp: forCamp, classes: [], sessions: [], entryCaps: [], registrations: [] };
}

const ZERO_COUNTS: ChildCounts = { campSessions: 0, campClasses: 0, registrations: 0, registrationCampSessions: 0 };

function makeGateway(overrides: Partial<SyncGateway> = {}): SyncGateway {
  return {
    discoverCamps: vi.fn(async () => []),
    getCamp: vi.fn(async (id: string) => camp(id, new Date())),
    countChildChanges: vi.fn(async () => ZERO_COUNTS),
    fetchCampData: vi.fn(async (forCamp: Camp) => emptyCampData(forCamp)),
    ...overrides,
  };
}

function runOptions(directus: DirectusClient, now: Date, gateway: SyncGateway) {
  return {
    clubId: "club-1",
    now,
    directus,
    syncLog: new SyncLog(directus),
    personSync: new PersonSync(directus),
    gateway,
  };
}

describe("runSync", () => {
  it("records a skipped program run and never fetches camp data when needsSync rejects the camp", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const watermark = new Date(now.getTime() - 60 * 60 * 1000); // an hour ago - inside the 24h floor
    const stale = camp("camp-1", new Date(watermark.getTime() - 1000));

    const fetchMock = makeFetchMock({
      sync_program_runs: [
        {
          run_id: "prior-run",
          clubspot_camp_id: "camp-1",
          started_at: watermark.toISOString(),
          finished_at: watermark.toISOString(),
          status: "ok",
          items_created: 0,
          items_updated: 0,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);

    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway({ discoverCamps: vi.fn(async () => [stale]) });

    const result = await runSync(runOptions(directus, now, gateway));

    expect(gateway.fetchCampData).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "ok", programsChecked: 1, programsSynced: 0 });

    const skippedRow = fetchMock.mock.calls
      .filter(([url, init]) => url.includes("/items/sync_program_runs") && init?.method === "POST")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string)[0]);
    expect(skippedRow).toEqual([expect.objectContaining({ clubspot_camp_id: "camp-1", status: "skipped" })]);
  });

  it("continues syncing later camps after one throws, and still closes the run as failed", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const campA = camp("camp-a", now);
    const campB = camp("camp-b", now);

    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);

    const gateway = makeGateway({
      discoverCamps: vi.fn(async () => [campA, campB]),
      fetchCampData: vi.fn(async (forCamp: Camp) => {
        if (forCamp.id === "camp-a") {
          throw new Error("boom");
        }
        return emptyCampData(forCamp);
      }),
    });

    const result = await runSync(runOptions(directus, now, gateway));

    expect(result).toMatchObject({
      status: "failed",
      programsChecked: 2,
      programsSynced: 1,
      failedCampIds: ["camp-a"],
    });

    const programRunBodies = fetchMock.mock.calls
      .filter(([url, init]) => url.includes("/items/sync_program_runs") && init?.method === "POST")
      .map(([, init]) => JSON.parse((init as RequestInit).body as string)[0]);
    expect(programRunBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ clubspot_camp_id: "camp-a", status: "failed", error: "boom" }),
        expect.objectContaining({ clubspot_camp_id: "camp-b", status: "ok" }),
      ]),
    );

    const finishRunCall = fetchMock.mock.calls.find(
      ([url, init]) => url.includes("/items/sync_runs/") && init?.method === "PATCH",
    );
    expect(finishRunCall).toBeDefined();
    const [, finishInit] = finishRunCall!;
    expect(JSON.parse((finishInit as RequestInit).body as string)).toMatchObject({ status: "failed" });
  });

  it("marks the run failed - the signal main.ts uses to exit non-zero - when a camp's sync throws", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);

    const gateway = makeGateway({
      discoverCamps: vi.fn(async () => [camp("camp-a", now)]),
      fetchCampData: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    const result = await runSync(runOptions(directus, now, gateway));

    expect(result.status).toBe("failed");
    expect(result.failedCampIds).toEqual(["camp-a"]);
  });

  it("in dry-run mode, issues only reads - no write reaches Directus, including the sync log", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const fetchMock = makeFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token, true);

    const gateway = makeGateway({ discoverCamps: vi.fn(async () => [camp("camp-a", now)]) });

    const result = await runSync(runOptions(directus, now, gateway));

    expect(result.status).toBe("ok");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit | undefined][]) {
      expect(init?.method ?? "GET").toBe("GET");
    }
  });

  it("passes the camp's watermark and the run's start to fetchCampData", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const watermark = new Date("2026-01-14T00:00:00Z"); // inside the 24h refresh floor
    const theCamp = camp("camp-a", watermark);

    const fetchMock = makeFetchMock({
      sync_program_runs: [
        {
          run_id: "prior-run",
          clubspot_camp_id: "camp-a",
          started_at: watermark.toISOString(),
          finished_at: watermark.toISOString(),
          status: "ok",
          items_created: 0,
          items_updated: 0,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const gateway = makeGateway({ discoverCamps: vi.fn(async () => [theCamp]) });

    await runSync(runOptions(directus, now, gateway));

    expect(gateway.fetchCampData).toHaveBeenCalledWith(theCamp, watermark, now);
  });

  // The regression test for finding 3: `registrations` already has a row for reg-1, pointing at
  // person-1. Its participant's name below has since been corrected in Clubspot, which is exactly
  // the case that made a fresh match choose - or create - a different person. The sync must reuse
  // person-1 instead of re-matching.
  it("reuses an existing registration's person_id for its participant, without re-matching", async () => {
    const now = new Date("2026-01-15T12:00:00Z");
    const theCamp = camp("camp-a", now);

    const existingRegistrationRow = {
      id: "reg-row-1",
      clubspot_registration_id: "reg-1",
      person_id: "person-1",
      program_id: "program-1",
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

    const fetchMock = makeFetchMock({ registrations: [existingRegistrationRow] });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);

    const gateway = makeGateway({
      discoverCamps: vi.fn(async () => [theCamp]),
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
