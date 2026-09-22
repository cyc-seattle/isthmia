import { describe, it, expect, vi, afterEach } from "vitest";
import { AuditFindingRow, DirectusClient } from "@cyc-seattle/directus";
import { Group, GroupMember, GroupSettings } from "@cyc-seattle/gsuite";
import { fingerprintFinding } from "../src/audit.js";
import { SettingsReader } from "../src/audit-settings.js";
import { DirectoryReader, runAudit } from "../src/audit-writer.js";

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

/** A stateful in-memory Directus stand-in, matching `run.test.ts`'s fixture. */
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

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
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
    if (method === "DELETE") {
      const rows = table(collection!);
      const index = rows.findIndex((row) => row.id === id);
      if (index !== -1) {
        rows.splice(index, 1);
      }
      return jsonResponse(204, undefined);
    }
    return jsonResponse(204, undefined);
  });

  return { fetchMock, tables };
}

function fakeDirectory(overrides: Partial<DirectoryReader> = {}): DirectoryReader {
  return {
    async getGroup(groupKey: string): Promise<Group | null> {
      return { id: groupKey, email: groupKey };
    },
    async listMembers(): Promise<GroupMember[]> {
      return [];
    },
    ...overrides,
  };
}

function fakeSettingsReader(): SettingsReader {
  return {
    async getSettings(): Promise<GroupSettings> {
      return {};
    },
  };
}

const now = new Date("2026-06-15T00:00:00Z");

describe("runAudit", () => {
  it("raises an unexpected_member finding for a live member outside the plan", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      google_groups: [{ id: "group-1", email: "class@cyccommunitysailing.org" }],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const directory = fakeDirectory({
      async listMembers() {
        return [{ email: "extra@example.com", role: "MEMBER" }];
      },
    });

    await runAudit({ directus, directory, settings: fakeSettingsReader(), now, groupOwners: [] });

    const findings = tables.get("audit_findings") as AuditFindingRow[];
    expect(findings).toMatchObject([
      { kind: "unexpected_member", subject: "class@cyccommunitysailing.org", status: "open" },
    ]);
  });

  it("does not re-raise a finding whose fingerprint is already dismissed", async () => {
    const detail = "extra@example.com is a member of class@cyccommunitysailing.org but isn't in the plan for it";
    const dismissedFingerprint = fingerprintFinding({
      source: "gsuite-sync",
      kind: "unexpected_member",
      subject: "class@cyccommunitysailing.org",
      detail,
    });
    const { fetchMock, tables } = makeDirectusStore({
      google_groups: [{ id: "group-1", email: "class@cyccommunitysailing.org" }],
      audit_findings: [
        {
          id: "existing-1",
          source: "gsuite-sync",
          kind: "unexpected_member",
          subject: "class@cyccommunitysailing.org",
          detail,
          status: "dismissed",
          fingerprint: dismissedFingerprint,
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const directory = fakeDirectory({
      async listMembers() {
        return [{ email: "extra@example.com", role: "MEMBER" }];
      },
    });

    await runAudit({ directus, directory, settings: fakeSettingsReader(), now, groupOwners: [] });

    const findings = tables.get("audit_findings") as AuditFindingRow[];
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("dismissed");
  });

  it("resolves an open finding whose condition no longer reproduces", async () => {
    const staleDetail = "extra@example.com is a member of class@cyccommunitysailing.org but isn't in the plan for it";
    const { fetchMock, tables } = makeDirectusStore({
      google_groups: [{ id: "group-1", email: "class@cyccommunitysailing.org" }],
      audit_findings: [
        {
          id: "existing-1",
          source: "gsuite-sync",
          kind: "unexpected_member",
          subject: "class@cyccommunitysailing.org",
          detail: staleDetail,
          status: "open",
          fingerprint: fingerprintFinding({
            source: "gsuite-sync",
            kind: "unexpected_member",
            subject: "class@cyccommunitysailing.org",
            detail: staleDetail,
          }),
        },
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    // The member who caused the old finding is gone from live membership now - resolved by hand.
    const directory = fakeDirectory({
      async listMembers() {
        return [];
      },
    });

    await runAudit({ directus, directory, settings: fakeSettingsReader(), now, groupOwners: [] });

    expect(tables.get("audit_findings")).toEqual([]);
  });

  it("with --dry-run's DirectusClient, computes findings but writes none of them", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      google_groups: [{ id: "group-1", email: "class@cyccommunitysailing.org" }],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token, true);
    const directory = fakeDirectory({
      async listMembers() {
        return [{ email: "extra@example.com", role: "MEMBER" }];
      },
    });

    await runAudit({ directus, directory, settings: fakeSettingsReader(), now, groupOwners: [] });

    expect(tables.get("audit_findings") ?? []).toEqual([]);
  });
});
