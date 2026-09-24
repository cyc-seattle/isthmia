import { describe, it, expect, vi, afterEach } from "vitest";
import { DirectusClient } from "@cyc-seattle/directus";
import { Group, GroupMember } from "@cyc-seattle/gsuite";
import { GroupDirectoryReader, runDiscovery } from "../src/discovery-writer.js";
import { GoogleGroupRow } from "../src/schema.js";

// This package's tsconfig has no DOM lib, so the ambient `RequestInit` resolves to an empty
// structural type rather than undici's real one (see @cyc-seattle/directus's client.ts). This
// local alias covers the fields these tests assert on from a captured fetch-mock call.
type FetchInit = { method?: string; body?: unknown };

const baseUrl = "https://directus.example.com";
const token = "test-token";
const customer = "C01yd45n0";

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

/** A stateful in-memory Directus stand-in, matching `run.test.ts`'s fixture. */
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

  const fetchMock = vi.fn(async (url: string, init?: FetchInit) => {
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    const [, , collection, id] = parsed.pathname.split("/");

    if (method === "GET") {
      return jsonResponse(200, { data: table(collection!) });
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

function fakeDirectory(overrides: Partial<GroupDirectoryReader> = {}): GroupDirectoryReader {
  return {
    async listGroups(): Promise<Group[]> {
      return [];
    },
    async listMembers(): Promise<GroupMember[]> {
      return [];
    },
    ...overrides,
  };
}

describe("runDiscovery", () => {
  it("creates a google_groups row for a new live group", async () => {
    const { fetchMock, tables } = makeDirectusStore({});
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const directory = fakeDirectory({
      async listGroups() {
        return [{ id: "live-1", email: "staff@cyccommunitysailing.org", name: "Staff" }];
      },
    });

    await runDiscovery({ directus, directory, customer });

    expect(tables.get("google_groups")).toMatchObject([{ email: "staff@cyccommunitysailing.org", name: "Staff" }]);
  });

  it("refreshes an existing row's name without touching its staff-set settings_template", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      google_groups: [
        {
          id: "row-1",
          email: "staff@cyccommunitysailing.org",
          name: "Staff",
          settings_template: { whoCanJoin: "INVITED_CAN_JOIN" },
          parent_id: null,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const directory = fakeDirectory({
      async listGroups() {
        return [{ id: "live-1", email: "staff@cyccommunitysailing.org", name: "Staff (renamed)" }];
      },
    });

    await runDiscovery({ directus, directory, customer });

    const rows = tables.get("google_groups") as unknown as GoogleGroupRow[];
    expect(rows).toMatchObject([
      {
        id: "row-1",
        name: "Staff (renamed)",
        settings_template: { whoCanJoin: "INVITED_CAN_JOIN" },
      },
    ]);
  });

  it("derives parent_id from a sub-group's live membership", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      google_groups: [
        {
          id: "program-1",
          email: "program@cyccommunitysailing.org",
          name: null,
          settings_template: null,
          parent_id: null,
        },
        { id: "class-1", email: "class@cyccommunitysailing.org", name: null, settings_template: null, parent_id: null },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const directory = fakeDirectory({
      async listGroups() {
        return [
          { id: "program-1", email: "program@cyccommunitysailing.org" },
          { id: "class-1", email: "class@cyccommunitysailing.org" },
        ];
      },
      async listMembers(groupKey: string) {
        if (groupKey === "program@cyccommunitysailing.org") {
          return [{ email: "class@cyccommunitysailing.org", role: "MEMBER", type: "GROUP" }];
        }
        return [];
      },
    });

    await runDiscovery({ directus, directory, customer });

    const rows = tables.get("google_groups") as unknown as GoogleGroupRow[];
    expect(rows).toContainEqual(expect.objectContaining({ id: "class-1", parent_id: "program-1" }));
  });

  it("with --dry-run's DirectusClient, computes the plan but writes nothing", async () => {
    const { fetchMock, tables } = makeDirectusStore({});
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token, true);
    const directory = fakeDirectory({
      async listGroups() {
        return [{ id: "live-1", email: "staff@cyccommunitysailing.org", name: "Staff" }];
      },
    });

    await runDiscovery({ directus, directory, customer });

    expect(tables.get("google_groups") ?? []).toEqual([]);
  });
});
