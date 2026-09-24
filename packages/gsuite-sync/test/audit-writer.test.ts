import { describe, it, expect, vi, afterEach } from "vitest";
import { AuditFindingRow, DirectusClient } from "@cyc-seattle/directus";
import { Group, GroupMember, GroupSettings } from "@cyc-seattle/gsuite";
import { fingerprintFinding } from "../src/audit.js";
import { SettingsReader } from "../src/audit-settings.js";
import { DirectoryReader, runAudit } from "../src/audit-writer.js";

// This package's tsconfig has no DOM lib, so the ambient `RequestInit` resolves to an empty
// structural type rather than undici's real one (see @cyc-seattle/directus's client.ts). This
// local alias covers the fields these tests assert on from a captured fetch-mock call.
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

/**
 * A stateful in-memory Directus stand-in, matching `run.test.ts`'s fixture, except for `DELETE`:
 * the gsuite-sync machine user is only granted `create`/`read`/`update` on `audit_findings`
 * (`packages/infrastructure/src/crm/index.ts`), so this store 403s a delete instead of allowing
 * one - a test that tried to resolve a finding by deleting it would fail here, not silently pass.
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
    if (method === "DELETE") {
      return jsonResponse(403, { errors: [{ message: `${collection} does not grant permission to delete` }] });
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
      programs: [{ id: "program-1", name: "Double-handed", google_group_id: "group-1", revenue_account: null }],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const directory = fakeDirectory({
      async listMembers() {
        return [{ email: "extra@example.com", role: "MEMBER" }];
      },
    });

    await runAudit({ directus, directory, settings: fakeSettingsReader(), now, groupOwners: [] });

    const findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toMatchObject([
      { kind: "unexpected_member", subject: "class@cyccommunitysailing.org", status: "open" },
    ]);
  });

  it("does not audit the membership of a group no program points at", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      google_groups: [{ id: "group-1", email: "doublehanded@cyccommunitysailing.org" }],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const directory = fakeDirectory({
      async listMembers() {
        return [{ email: "extra@example.com", role: "MEMBER" }];
      },
    });

    await runAudit({ directus, directory, settings: fakeSettingsReader(), now, groupOwners: [] });

    expect(tables.get("audit_findings") ?? []).toEqual([]);
  });

  it("raises stale_member, not unexpected_member, for a live member from a season outside the membership window", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      google_groups: [{ id: "group-1", email: "program@cyccommunitysailing.org" }],
      programs: [{ id: "program-1", name: "Double-handed", google_group_id: "group-1" }],
      classes: [{ id: "class-1", camp_id: "camp-1", program_id: "program-1" }],
      camps: [{ id: "camp-1", end_date: "2025-01-01T00:00:00Z" }],
      registration_entries: [{ id: "e1", registration_id: "r1", class_id: "class-1", status: "confirmed" }],
      registrations: [{ id: "r1", person_id: "participant" }],
      people: [{ id: "participant", email: "participant@example.com" }],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const directory = fakeDirectory({
      async listMembers() {
        return [{ email: "participant@example.com", role: "MEMBER" }];
      },
    });

    await runAudit({ directus, directory, settings: fakeSettingsReader(), now, groupOwners: [] });

    const findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toMatchObject([
      { kind: "stale_member", subject: "program@cyccommunitysailing.org", status: "open" },
    ]);
    expect(findings.some((finding) => finding["kind"] === "unexpected_member")).toBe(false);
  });

  it("raises mismatched_revenue_account when a camp's classes map to programs with different revenue accounts", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      camps: [{ id: "camp-1", name: "2026 Fall Sailing", clubspot_sales_account: "4000-YOUTH", end_date: null }],
      classes: [
        { id: "class-1", camp_id: "camp-1", program_id: "program-1" },
        { id: "class-2", camp_id: "camp-1", program_id: "program-2" },
      ],
      programs: [
        { id: "program-1", name: "Program 1", google_group_id: "group-1", revenue_account: "4000-YOUTH" },
        { id: "program-2", name: "Program 2", google_group_id: "group-1", revenue_account: "4100-ADULT" },
      ],
      google_groups: [{ id: "group-1", email: "program@cyccommunitysailing.org" }],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);
    const directory = fakeDirectory();

    await runAudit({ directus, directory, settings: fakeSettingsReader(), now, groupOwners: [] });

    const findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toMatchObject([{ kind: "mismatched_revenue_account", subject: "camp-1", status: "open" }]);
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

    const findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("dismissed");
  });

  it("marks an open finding resolved, rather than deleting it, when its condition no longer reproduces", async () => {
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

    const findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toMatchObject([{ id: "existing-1", status: "resolved" }]);
  });

  it("reopens a resolved finding whose condition recurs with the same fingerprint", async () => {
    const detail = "extra@example.com is a member of class@cyccommunitysailing.org but isn't in the plan for it";
    const fingerprint = fingerprintFinding({
      source: "gsuite-sync",
      kind: "unexpected_member",
      subject: "class@cyccommunitysailing.org",
      detail,
    });
    const { fetchMock, tables } = makeDirectusStore({
      google_groups: [{ id: "group-1", email: "class@cyccommunitysailing.org" }],
      programs: [{ id: "program-1", name: "Double-handed", google_group_id: "group-1", revenue_account: null }],
      audit_findings: [
        {
          id: "existing-1",
          source: "gsuite-sync",
          kind: "unexpected_member",
          subject: "class@cyccommunitysailing.org",
          detail,
          status: "resolved",
          fingerprint,
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

    const findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toMatchObject([{ id: "existing-1", status: "open", fingerprint }]);
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
