import { describe, it, expect, vi, afterEach } from "vitest";
import { DirectusClient, SyncQueue } from "@cyc-seattle/directus";
import {
  AddMemberResult,
  Group,
  GroupMember,
  GroupRole,
  GroupSettings,
  resolveGroupSettingsTemplate,
} from "@cyc-seattle/gsuite";
import { SettingsReader } from "../src/audit-settings.js";
import { DirectoryReader } from "../src/audit-writer.js";
import { MemberAdder } from "../src/directory-writer.js";
import { GroupDirectoryReader } from "../src/discovery-writer.js";
import {
  enqueueAudit,
  enqueueDiscovery,
  enqueueDueClassGroups,
  enqueueGroupManagers,
  enqueueGroupNesting,
  enqueueGroupOwners,
  enqueueGroupSettings,
  runGroupSync,
} from "../src/run.js";
import { SettingsApplier } from "../src/settings-writer.js";

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

/** A stateful in-memory Directus stand-in, matching clubspot-sync's `sync-run.test.ts` fixture:
 * good enough to exercise the queue's enqueue/claim cycle, which a mock that only echoes each call
 * back can't. */
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
      const match = /^filter\[([^\]]+)\]\[_eq\]$/.exec(key);
      if (match && String(row[match[1]!] ?? "") !== value) {
        return false;
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

function recordingAdder(): MemberAdder & { calls: [string, string, GroupRole][] } {
  const calls: [string, string, GroupRole][] = [];
  return {
    calls,
    async addMember(groupKey: string, email: string, role: GroupRole): Promise<AddMemberResult> {
      calls.push([groupKey, email, role]);
      return "added";
    },
  };
}

function recordingSettingsApplier(): SettingsApplier & { calls: [string, GroupSettings][] } {
  const calls: [string, GroupSettings][] = [];
  return {
    calls,
    async patchSettings(groupEmail: string, settings: GroupSettings): Promise<GroupSettings> {
      calls.push([groupEmail, settings]);
      return settings;
    },
  };
}

/** Every group exists, with no live members and nothing new to discover - the audit and discovery
 * passes' reads have nothing to flag or add by default in these fixtures, which are about the
 * write passes, not those two. */
function fakeDirectory(
  overrides: Partial<DirectoryReader & GroupDirectoryReader> = {},
): DirectoryReader & GroupDirectoryReader {
  return {
    async getGroup(groupKey: string): Promise<Group | null> {
      return { id: groupKey, email: groupKey };
    },
    async listMembers(): Promise<GroupMember[]> {
      return [];
    },
    async listGroups(): Promise<Group[]> {
      return [];
    },
    ...overrides,
  };
}

function fakeSettingsReader(overrides: Partial<SettingsReader> = {}): SettingsReader {
  return {
    async getSettings(): Promise<GroupSettings> {
      return {};
    },
    ...overrides,
  };
}

const now = new Date("2026-06-15T00:00:00Z");

describe("enqueueDueClassGroups", () => {
  it("enqueues only classes with a google_group_id whose camp is current or upcoming", async () => {
    const { fetchMock } = makeDirectusStore({
      classes: [
        { id: "class-current", camp_id: "camp-current", google_group_id: "group-1" },
        { id: "class-past", camp_id: "camp-past", google_group_id: "group-1" },
        { id: "class-no-group", camp_id: "camp-current", google_group_id: null },
      ],
      camps: [
        { id: "camp-current", end_date: "2026-08-01T00:00:00Z" },
        { id: "camp-past", end_date: "2026-01-01T00:00:00Z" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);

    const taskIds = await enqueueDueClassGroups(now, directus, queue);

    expect(taskIds).toHaveLength(1);
    const tasks = await directus.readItems("sync_tasks", { limit: -1 });
    expect(tasks).toMatchObject([{ key: "gsuite-sync:sync_class_members:class-current" }]);
  });
});

describe("enqueueGroupSettings", () => {
  it("enqueues only groups with a settings_template set", async () => {
    const { fetchMock } = makeDirectusStore({
      google_groups: [
        {
          id: "group-1",
          email: "class@cyccommunitysailing.org",
          settings_template: "participants",
        },
        { id: "group-2", email: "other@cyccommunitysailing.org", settings_template: null },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);

    const taskIds = await enqueueGroupSettings(now, directus, queue);

    expect(taskIds).toHaveLength(1);
    const tasks = await directus.readItems("sync_tasks", { limit: -1 });
    expect(tasks).toMatchObject([{ key: "gsuite-sync:sync_group_settings:group-1" }]);
  });
});

describe("enqueueGroupNesting", () => {
  it("enqueues only groups whose parent_id resolves to another group", async () => {
    const { fetchMock } = makeDirectusStore({
      google_groups: [
        { id: "program-1", email: "program@cyccommunitysailing.org", parent_id: null },
        { id: "class-1", email: "class@cyccommunitysailing.org", parent_id: "program-1" },
        { id: "class-2", email: "orphan@cyccommunitysailing.org", parent_id: "missing" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);

    const taskIds = await enqueueGroupNesting(now, directus, queue);

    expect(taskIds).toHaveLength(1);
    const tasks = await directus.readItems("sync_tasks", { limit: -1 });
    expect(tasks).toMatchObject([{ key: "gsuite-sync:sync_group_nesting:class-1" }]);
  });
});

describe("enqueueGroupManagers", () => {
  it("enqueues only programs with a google_group_id set, keyed on the program's own id", async () => {
    const { fetchMock } = makeDirectusStore({
      programs: [
        { id: "program-1", name: "Double-handed", google_group_id: "group-1" },
        { id: "program-2", name: "No group", google_group_id: null },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);

    const taskIds = await enqueueGroupManagers(now, directus, queue);

    expect(taskIds).toHaveLength(1);
    const tasks = await directus.readItems("sync_tasks", { limit: -1 });
    expect(tasks).toMatchObject([{ key: "gsuite-sync:sync_group_managers:program-1" }]);
  });

  it("enqueues a separate task per program even when two programs share one Google Group", async () => {
    const { fetchMock } = makeDirectusStore({
      programs: [
        { id: "program-1", name: "Double-handed", google_group_id: "shared-group" },
        { id: "program-2", name: "Single-handed", google_group_id: "shared-group" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);

    const taskIds = await enqueueGroupManagers(now, directus, queue);

    expect(taskIds).toHaveLength(2);
    const tasks = await directus.readItems("sync_tasks", { limit: -1 });
    expect(tasks).toMatchObject([
      { key: "gsuite-sync:sync_group_managers:program-1" },
      { key: "gsuite-sync:sync_group_managers:program-2" },
    ]);
  });
});

describe("enqueueGroupOwners", () => {
  it("enqueues one task per google_groups row", async () => {
    const { fetchMock } = makeDirectusStore({
      google_groups: [
        { id: "group-1", email: "a@cyccommunitysailing.org" },
        { id: "group-2", email: "b@cyccommunitysailing.org" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);

    const taskIds = await enqueueGroupOwners(now, directus, queue);

    expect(taskIds).toHaveLength(2);
  });
});

describe("enqueueAudit", () => {
  it("enqueues exactly one task, regardless of how many groups or programs exist", async () => {
    const { fetchMock } = makeDirectusStore({
      google_groups: [{ id: "group-1", email: "a@cyccommunitysailing.org" }],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);

    const taskIds = await enqueueAudit(now, queue);

    expect(taskIds).toHaveLength(1);
    const tasks = await directus.readItems("sync_tasks", { limit: -1 });
    expect(tasks).toMatchObject([{ key: "gsuite-sync:sync_audit_findings:run" }]);
  });
});

describe("enqueueDiscovery", () => {
  it("enqueues exactly one task, on its own queue rather than gsuite-sync", async () => {
    const { fetchMock } = makeDirectusStore({});
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);

    const taskIds = await enqueueDiscovery(now, queue);

    expect(taskIds).toHaveLength(1);
    const tasks = await directus.readItems("sync_tasks", { limit: -1 });
    expect(tasks).toMatchObject([{ key: "gsuite-sync-discovery:sync_group_discovery:run" }]);
  });
});

describe("runGroupSync", () => {
  it("adds every planned class member as MEMBER and reports the task as checked", async () => {
    const { fetchMock } = makeDirectusStore({
      classes: [{ id: "class-1", camp_id: "camp-1", google_group_id: "group-1" }],
      camps: [{ id: "camp-1", end_date: null }],
      google_groups: [{ id: "group-1", email: "class-1@cyccommunitysailing.org" }],
      registration_entries: [{ id: "e1", registration_id: "r1", class_id: "class-1", status: "confirmed" }],
      registrations: [{ id: "r1", person_id: "participant" }],
      people: [{ id: "participant", email: "participant@example.com" }],
      contacts: [],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);
    const adder = recordingAdder();
    const settingsApplier = recordingSettingsApplier();

    const result = await runGroupSync({
      now,
      directus,
      queue,
      adder,
      settingsApplier,
      directory: fakeDirectory(),
      settingsReader: fakeSettingsReader(),
      groupOwners: [],
      customer,
    });

    // tasksChecked also counts the discovery task, the owners pass's task for group-1 (which does
    // nothing here - groupOwners is empty), and the one audit task.
    expect(result).toEqual({ status: "ok", tasksChecked: 4, tasksFailed: 0 });
    expect(adder.calls).toEqual([["class-1@cyccommunitysailing.org", "participant@example.com", "MEMBER"]]);
  });

  it("cancels a class-members task instead of failing when its group can't be found", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      classes: [{ id: "class-1", camp_id: "camp-1", google_group_id: "missing-group" }],
      camps: [{ id: "camp-1", end_date: null }],
      google_groups: [],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);
    const adder = recordingAdder();
    const settingsApplier = recordingSettingsApplier();

    const result = await runGroupSync({
      now,
      directus,
      queue,
      adder,
      settingsApplier,
      directory: fakeDirectory(),
      settingsReader: fakeSettingsReader(),
      groupOwners: [],
      customer,
    });

    // Not a failure: the referenced google_groups row is gone, so retrying can never succeed.
    expect(result.status).toBe("ok");
    expect(result.tasksFailed).toBe(0);
    expect(adder.calls).toEqual([]);
    const tasks = tables.get("sync_tasks") as { key: string; status: string }[];
    expect(tasks).toContainEqual(
      expect.objectContaining({ key: "gsuite-sync:sync_class_members:class-1", status: "cancelled" }),
    );
  });

  it("grants both programs' managers when two programs share one Google Group", async () => {
    const { fetchMock } = makeDirectusStore({
      google_groups: [{ id: "shared-group", email: "shared@cyccommunitysailing.org" }],
      programs: [
        { id: "program-1", name: "Double-handed", google_group_id: "shared-group" },
        { id: "program-2", name: "Single-handed", google_group_id: "shared-group" },
      ],
      program_roles: [
        {
          id: "pr-1",
          person_id: "manager-1",
          program_id: "program-1",
          role_id: "parent-coordinator",
          starts_on: null,
          ends_on: null,
        },
        {
          id: "pr-2",
          person_id: "manager-2",
          program_id: "program-2",
          role_id: "parent-coordinator",
          starts_on: null,
          ends_on: null,
        },
      ],
      google_group_roles: [{ id: "gr-1", program_role_type_id: "parent-coordinator", google_role: "MANAGER" }],
      people: [
        { id: "manager-1", email: "manager1@example.com" },
        { id: "manager-2", email: "manager2@example.com" },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);
    const adder = recordingAdder();
    const settingsApplier = recordingSettingsApplier();

    const result = await runGroupSync({
      now,
      directus,
      queue,
      adder,
      settingsApplier,
      directory: fakeDirectory(),
      settingsReader: fakeSettingsReader(),
      groupOwners: [],
      customer,
    });

    expect(result.status).toBe("ok");
    expect(adder.calls).toContainEqual(["shared@cyccommunitysailing.org", "manager1@example.com", "MANAGER"]);
    expect(adder.calls).toContainEqual(["shared@cyccommunitysailing.org", "manager2@example.com", "MANAGER"]);
  });

  it("accounts for a task claimed this run even though it wasn't enqueued this run", async () => {
    // A class-members task left over from a prior run, whose class has since been deleted -
    // `enqueueDueClassGroups` won't re-enqueue it, but it's still pending and due.
    const { fetchMock, tables } = makeDirectusStore({
      sync_tasks: [
        {
          id: "orphan-task",
          queue: "gsuite-sync",
          kind: "sync_class_members",
          key: "gsuite-sync:sync_class_members:ghost-class",
          parent_id: null,
          status: "pending",
          attempts: 0,
          max_attempts: 5,
          run_after: null,
          last_error: null,
          started_at: null,
          finished_at: null,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);
    const adder = recordingAdder();
    const settingsApplier = recordingSettingsApplier();

    const result = await runGroupSync({
      now,
      directus,
      queue,
      adder,
      settingsApplier,
      directory: fakeDirectory(),
      settingsReader: fakeSettingsReader(),
      groupOwners: [],
      customer,
    });

    // The discovery and audit tasks were enqueued this run - the orphan must still be counted as checked.
    expect(result.tasksChecked).toBe(3);
    expect(result.status).toBe("ok");
    expect(result.tasksFailed).toBe(0);
    const orphan = (tables.get("sync_tasks") as { id: string; status: string }[]).find(
      (task) => task.id === "orphan-task",
    );
    expect(orphan?.status).toBe("cancelled");
  });

  it("applies settings, nests a class group under its program group, adds a current manager, and adds every configured owner", async () => {
    const { fetchMock } = makeDirectusStore({
      google_groups: [
        { id: "program-group", email: "program@cyccommunitysailing.org", settings_template: null, parent_id: null },
        {
          id: "class-group",
          email: "class@cyccommunitysailing.org",
          settings_template: "participants",
          parent_id: "program-group",
        },
      ],
      programs: [{ id: "program-1", name: "Double-handed", google_group_id: "program-group" }],
      program_roles: [
        {
          id: "pr-1",
          person_id: "coordinator",
          program_id: "program-1",
          role_id: "parent-coordinator",
          starts_on: null,
          ends_on: null,
        },
      ],
      google_group_roles: [{ id: "gr-1", program_role_type_id: "parent-coordinator", google_role: "MANAGER" }],
      people: [{ id: "coordinator", email: "coordinator@example.com" }],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);
    const adder = recordingAdder();
    const settingsApplier = recordingSettingsApplier();

    const result = await runGroupSync({
      now,
      directus,
      queue,
      adder,
      settingsApplier,
      directory: fakeDirectory(),
      settingsReader: fakeSettingsReader(),
      groupOwners: ["master@cyccommunitysailing.org"],
      customer,
    });

    expect(result.status).toBe("ok");
    expect(settingsApplier.calls).toEqual([
      ["class@cyccommunitysailing.org", resolveGroupSettingsTemplate("participants")],
    ]);
    expect(adder.calls).toContainEqual(["program@cyccommunitysailing.org", "class@cyccommunitysailing.org", "MEMBER"]);
    expect(adder.calls).toContainEqual(["program@cyccommunitysailing.org", "coordinator@example.com", "MANAGER"]);
    expect(adder.calls).toContainEqual(["program@cyccommunitysailing.org", "master@cyccommunitysailing.org", "OWNER"]);
    expect(adder.calls).toContainEqual(["class@cyccommunitysailing.org", "master@cyccommunitysailing.org", "OWNER"]);
  });

  it("fails the run instead of silently skipping a group whose settings_template name is unrecognized", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      google_groups: [
        { id: "group-1", email: "class@cyccommunitysailing.org", settings_template: "bogus", parent_id: null },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);
    const adder = recordingAdder();
    const settingsApplier = recordingSettingsApplier();

    const result = await runGroupSync({
      now,
      directus,
      queue,
      adder,
      settingsApplier,
      directory: fakeDirectory(),
      settingsReader: fakeSettingsReader(),
      groupOwners: [],
      customer,
    });

    expect(result.status).toBe("failed");
    expect(result.tasksFailed).toBeGreaterThan(0);
    expect(settingsApplier.calls).toEqual([]);
    const settingsTask = (tables.get("sync_tasks") as { key: string; status: string; last_error: string }[]).find(
      (task) => task.key === "gsuite-sync:sync_group_settings:group-1",
    );
    // "pending" (still retrying), not "cancelled" - a typo isn't a precondition that evaporated.
    expect(settingsTask).toMatchObject({ status: "pending" });
    expect(settingsTask?.last_error).toMatch(/Unknown Google Group settings template "bogus"/);
  });

  it("discovers a new Google Group into google_groups, on its own queue ahead of the other passes", async () => {
    const { fetchMock, tables } = makeDirectusStore({});
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const queue = new SyncQueue(directus);
    const adder = recordingAdder();
    const settingsApplier = recordingSettingsApplier();

    const result = await runGroupSync({
      now,
      directus,
      queue,
      adder,
      settingsApplier,
      directory: fakeDirectory({
        async listGroups() {
          return [{ id: "live-1", email: "staff@cyccommunitysailing.org", name: "Staff" }];
        },
      }),
      settingsReader: fakeSettingsReader(),
      groupOwners: [],
      customer,
    });

    expect(result.status).toBe("ok");
    expect(tables.get("google_groups")).toMatchObject([{ email: "staff@cyccommunitysailing.org", name: "Staff" }]);
    const discoveryTasks = (tables.get("sync_tasks") as { queue: string; kind: string; status: string }[]).filter(
      (task) => task.queue === "gsuite-sync-discovery",
    );
    expect(discoveryTasks).toMatchObject([{ kind: "sync_group_discovery", status: "done" }]);
  });
});
