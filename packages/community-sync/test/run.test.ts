import { describe, expect, it, vi, afterEach } from "vitest";
import { DirectusClient } from "@cyc-seattle/directus";
import { GroupMember } from "@cyc-seattle/gsuite";
import { AuthentikClient } from "../src/authentik.js";
import { runCommunitySync, StaffGroupSource } from "../src/run.js";

type FetchInit = { method?: string; body?: unknown };

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

/** Enough of Directus's `/items` REST API to run `runCommunitySync` end to end: every collection
 * read returns its seed rows untouched (no filtering, since these tests don't need it), and every
 * write echoes back what it was given, tagging a create with an id. */
function stubDirectus(seed: Partial<Record<string, unknown[]>> = {}): { calls: { method: string; path: string }[] } {
  const calls: { method: string; path: string }[] = [];
  let nextId = 1;

  const fetchMock = vi.fn(async (url: string, init?: FetchInit) => {
    const method = init?.method ?? "GET";
    const parsed = new URL(url);
    const [, , collection, id] = parsed.pathname.split("/");
    calls.push({ method, path: parsed.pathname });

    if (method === "GET") {
      return jsonResponse(200, { data: seed[collection!] ?? [] });
    }
    if (method === "POST") {
      const items = (init?.body ? JSON.parse(init.body as unknown as string) : []) as Record<string, unknown>[];
      const created = items.map((item) => ({ id: item["id"] ?? `generated-${nextId++}`, ...item }));
      return jsonResponse(200, { data: created });
    }
    if (method === "PATCH") {
      const body = init?.body ? JSON.parse(init.body as unknown as string) : {};
      const data = id ? { id, ...body } : body;
      return jsonResponse(200, { data });
    }
    throw new Error(`Unhandled method ${method}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function fakeAuthentik(): AuthentikClient {
  return {
    getGroup: vi.fn().mockResolvedValue({ pk: "group-pk", members: [] }),
    findUserByEmail: vi.fn().mockResolvedValue(null),
    createUser: vi.fn().mockResolvedValue({ pk: "user-pk", username: "a@example.com", email: "a@example.com" }),
    setGroupMembers: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeDirectory(members: GroupMember[] = []): StaffGroupSource {
  return { listMembers: vi.fn().mockResolvedValue(members) };
}

describe("runCommunitySync", () => {
  it("skips the family pass and reads no clubspot tables when --families is off", async () => {
    const { calls } = stubDirectus({ people: [] });
    const directus = new DirectusClient(baseUrl, token);
    const authentik = fakeAuthentik();

    const result = await runCommunitySync({
      now: new Date("2026-07-15T00:00:00Z"),
      directus,
      authentik,
      directory: fakeDirectory(),
      staffSourceGroup: "all@cyccommunitysailing.org",
      families: false,
    });

    expect(result.status).toBe("ok");
    expect(result.counts["familyAdded"]).toBeUndefined();
    expect(authentik.getGroup).not.toHaveBeenCalledWith("families");
    expect(calls.some((call) => call.path.includes("/items/camps"))).toBe(false);
    expect(calls.some((call) => call.path.includes("/items/registrations"))).toBe(false);
  });

  it("runs the family pass and reconciles both groups when --families is on", async () => {
    stubDirectus({
      people: [],
      camps: [],
      classes: [],
      registration_entries: [],
      registrations: [],
      participants: [],
      contacts: [],
    });
    const directus = new DirectusClient(baseUrl, token);
    const authentik = fakeAuthentik();

    const result = await runCommunitySync({
      now: new Date("2026-07-15T00:00:00Z"),
      directus,
      authentik,
      directory: fakeDirectory(),
      staffSourceGroup: "all@cyccommunitysailing.org",
      families: true,
    });

    expect(result.status).toBe("ok");
    expect(result.counts["familyAdded"]).toBe(0);
    expect(authentik.getGroup).toHaveBeenCalledWith("staff");
    expect(authentik.getGroup).toHaveBeenCalledWith("families");
  });

  it("mirrors all@ into the staff group", async () => {
    stubDirectus({ people: [] });
    const directus = new DirectusClient(baseUrl, token);
    const authentik = fakeAuthentik();
    const directory = fakeDirectory([{ email: "staffer@example.com", role: "MEMBER", type: "USER" }]);

    await runCommunitySync({
      now: new Date(),
      directus,
      authentik,
      directory,
      staffSourceGroup: "all@cyccommunitysailing.org",
      families: false,
    });

    expect(directory.listMembers).toHaveBeenCalledWith("all@cyccommunitysailing.org", {
      includeDerivedMembership: true,
    });
    expect(authentik.setGroupMembers).toHaveBeenCalledWith("group-pk", ["user-pk"]);
  });

  it("reports a failed run when a pass throws", async () => {
    stubDirectus({ people: [] });
    const directus = new DirectusClient(baseUrl, token);
    const authentik: AuthentikClient = {
      getGroup: vi.fn().mockRejectedValue(new Error("boom")),
      findUserByEmail: vi.fn(),
      createUser: vi.fn(),
      setGroupMembers: vi.fn(),
    };

    const result = await runCommunitySync({
      now: new Date(),
      directus,
      authentik,
      directory: fakeDirectory(),
      staffSourceGroup: "all@cyccommunitysailing.org",
      families: false,
    });

    expect(result.status).toBe("failed");
  });
});
