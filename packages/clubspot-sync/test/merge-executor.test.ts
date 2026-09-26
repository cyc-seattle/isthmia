import { describe, it, expect, vi, afterEach } from "vitest";
import { AuditFindingRow, DirectusClient, fingerprintFinding, ItemQuery } from "@cyc-seattle/directus";
import { runApprovedPersonMerges } from "../src/merge-executor.js";

type FetchInit = { method?: string; body?: unknown };

const baseUrl = "https://directus.example.com";
const token = "test-token";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/** The real schema's unique indexes that a botched merge step ordering could violate. */
const UNIQUE_FIELDS: Record<string, readonly string[]> = {
  people: ["directus_user_id"],
  medical_profiles: ["person_id"],
};

/**
 * A stateful in-memory Directus stand-in, same shape as `sync-run.test.ts`'s, but with a DELETE
 * that actually removes the row - the merge executor's final guard depends on a deleted
 * duplicate staying gone for the rest of the same test - and a PATCH/POST that rejects a write
 * colliding with `UNIQUE_FIELDS`, the same way Directus's own unique index would.
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

  /** The first unique field a write would collide on, checked against every other row - `undefined` when the write is clear. */
  function uniqueConflict(
    collection: string,
    ownId: string | undefined,
    row: Record<string, unknown>,
  ): string | undefined {
    for (const field of UNIQUE_FIELDS[collection] ?? []) {
      const value = row[field];
      if (value == null) {
        continue;
      }
      if (table(collection).some((other) => other["id"] !== ownId && other[field] === value)) {
        return field;
      }
    }
    return undefined;
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
      for (const item of created) {
        const conflict = uniqueConflict(collection!, item["id"] as string, item);
        if (conflict) {
          return jsonResponse(409, {
            errors: [{ message: `Unique constraint violation on ${collection}.${conflict}` }],
          });
        }
      }
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
      const merged = { ...rows[index], ...patch };
      const conflict = uniqueConflict(collection!, id, merged);
      if (conflict) {
        return jsonResponse(409, { errors: [{ message: `Unique constraint violation on ${collection}.${conflict}` }] });
      }
      rows[index] = merged;
      return jsonResponse(200, { data: rows[index] });
    }
    if (method === "DELETE") {
      const rows = table(collection!);
      const index = rows.findIndex((row) => row["id"] === id);
      if (index !== -1) {
        rows.splice(index, 1);
      }
      return jsonResponse(204, undefined);
    }
    return jsonResponse(204, undefined);
  });

  return { fetchMock, tables };
}

function person(id: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id,
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
    directus_user_id: null,
    ...overrides,
  };
}

function duplicatePersonFinding(overrides: Partial<AuditFindingRow> & { subject: string; detail: string }) {
  const base = {
    source: "clubspot-sync",
    kind: "duplicate_person",
    subject: overrides.subject,
    detail: overrides.detail,
  };
  return {
    id: "finding-1",
    status: "approved" as const,
    fingerprint: fingerprintFinding(base),
    ...base,
    ...overrides,
  };
}

const GROUP_DETAIL = "Jane Doe: person-1 (dob 2010-01-01), person-2 (dob 2011-02-02)";

describe("runApprovedPersonMerges", () => {
  it("merges an approved finding end to end: relinks, folds medical and contacts, dedupes, deletes the duplicate, resolves", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [
        person("person-1", { date_of_birth: "2010-01-01" }),
        person("person-2", { date_of_birth: "2011-02-02", school: "Roosevelt High" }),
      ],
      participants: [
        { id: "part-1", person_id: "person-1" },
        { id: "part-2", person_id: "person-2" },
      ],
      contacts: [
        { id: "c-keeper", subject_id: "person-1", contact_id: "contact-x", relationship_type: "guardian" },
        { id: "c-dup", subject_id: "person-2", contact_id: "contact-x", relationship_type: "guardian" },
      ],
      contact_points: [{ id: "cp-dup", person_id: "person-2", kind: "email", normalized: "jane@example.com" }],
      medical_profiles: [
        {
          id: "mp-keeper",
          person_id: "person-1",
          allergies: null,
          medications: null,
          conditions: null,
          physician_name: null,
          physician_phone: null,
          last_tetanus: null,
          weight: null,
        },
        {
          id: "mp-dup",
          person_id: "person-2",
          allergies: "peanuts",
          medications: null,
          conditions: null,
          physician_name: null,
          physician_phone: null,
          last_tetanus: null,
          weight: null,
        },
      ],
      program_role_assignments: [{ id: "pra-1", person_id: "person-2" }],
      event_staff: [{ id: "es-1", person_id: "person-2" }],
      audit_findings: [duplicatePersonFinding({ subject: "person-1", detail: GROUP_DETAIL })],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);

    const result = await runApprovedPersonMerges(directus);

    expect(result).toEqual({ mergesApplied: 1, mergesSkipped: 0 });
    expect(tables.get("people")).toEqual([expect.objectContaining({ id: "person-1", school: "Roosevelt High" })]);
    expect(tables.get("participants")).toContainEqual(expect.objectContaining({ id: "part-2", person_id: "person-1" }));
    expect(tables.get("medical_profiles")).toEqual([
      expect.objectContaining({ id: "mp-keeper", person_id: "person-1", allergies: "peanuts" }),
    ]);
    expect(tables.get("contacts")).toEqual([
      expect.objectContaining({ id: "c-keeper", subject_id: "person-1", contact_id: "contact-x" }),
    ]);
    expect(tables.get("contact_points")).toContainEqual(
      expect.objectContaining({ id: "cp-dup", person_id: "person-1" }),
    );
    expect(tables.get("program_role_assignments")).toContainEqual(
      expect.objectContaining({ id: "pra-1", person_id: "person-1" }),
    );
    expect(tables.get("event_staff")).toContainEqual(expect.objectContaining({ id: "es-1", person_id: "person-1" }));
    const findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toEqual([expect.objectContaining({ id: "finding-1", status: "resolved" })]);
  });

  it("reopens the finding, without writing anything, when a member row no longer exists", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [person("person-1")], // person-2 is gone
      participants: [{ id: "part-1", person_id: "person-1" }],
      audit_findings: [duplicatePersonFinding({ subject: "person-1", detail: GROUP_DETAIL })],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);

    const result = await runApprovedPersonMerges(directus);

    expect(result).toEqual({ mergesApplied: 0, mergesSkipped: 1 });
    const findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toEqual([expect.objectContaining({ id: "finding-1", status: "open" })]);
    expect(tables.get("participants")).toEqual([{ id: "part-1", person_id: "person-1" }]);
  });

  it("reopens the finding when the group's names no longer match", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [person("person-1"), person("person-2", { first_name: "Someone", last_name: "Else" })],
      audit_findings: [duplicatePersonFinding({ subject: "person-1", detail: GROUP_DETAIL })],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);

    const result = await runApprovedPersonMerges(directus);

    expect(result).toEqual({ mergesApplied: 0, mergesSkipped: 1 });
    const findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toEqual([expect.objectContaining({ id: "finding-1", status: "open" })]);
  });

  it("reopens the finding, without writing anything, when two rows already have a directus_user_id", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [person("person-1", { directus_user_id: "du-1" }), person("person-2", { directus_user_id: "du-2" })],
      participants: [{ id: "part-1", person_id: "person-2" }],
      audit_findings: [duplicatePersonFinding({ subject: "person-1", detail: GROUP_DETAIL })],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);

    const result = await runApprovedPersonMerges(directus);

    expect(result).toEqual({ mergesApplied: 0, mergesSkipped: 1 });
    const findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toEqual([expect.objectContaining({ id: "finding-1", status: "open" })]);
    // No relink happened - the plan was never applied, only rejected.
    expect(tables.get("participants")).toEqual([{ id: "part-1", person_id: "person-2" }]);
  });

  it("moves a lone directus_user_id onto the keeper by clearing the duplicate's copy first", async () => {
    // The in-memory store enforces `people.directus_user_id`'s unique index (see `UNIQUE_FIELDS`),
    // so setting the keeper's copy before the duplicate's is cleared would 409 here exactly as it
    // would against real Directus.
    const { fetchMock, tables } = makeDirectusStore({
      people: [person("person-1"), person("person-2", { directus_user_id: "du-1" })],
      audit_findings: [duplicatePersonFinding({ subject: "person-1", detail: GROUP_DETAIL })],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);

    const result = await runApprovedPersonMerges(directus);

    expect(result).toEqual({ mergesApplied: 1, mergesSkipped: 0 });
    expect(tables.get("people")).toEqual([expect.objectContaining({ id: "person-1", directus_user_id: "du-1" })]);
  });

  it("leaves a duplicate and reopens the finding when a reference to it remains after the merge", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [person("person-1"), person("person-2")],
      event_staff: [{ id: "es-1", person_id: "person-2" }],
      audit_findings: [duplicatePersonFinding({ subject: "person-1", detail: GROUP_DETAIL })],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);

    // Simulates a reference created after the plan's own read - e.g. a concurrent write - by
    // making the final guard's second read of event_staff see one more row than the plan did.
    const originalReadItems = DirectusClient.prototype.readItems;
    let eventStaffReads = 0;
    vi.spyOn(DirectusClient.prototype, "readItems").mockImplementation(async function (
      this: DirectusClient,
      collection: string,
      query?: ItemQuery,
    ) {
      const rows = await originalReadItems.call(this, collection, query);
      if (collection === "event_staff") {
        eventStaffReads++;
        if (eventStaffReads > 1) {
          return [...rows, { id: "es-extra", person_id: "person-2" }];
        }
      }
      return rows;
    });

    const result = await runApprovedPersonMerges(directus);

    expect(result).toEqual({ mergesApplied: 0, mergesSkipped: 1 });
    // The real event_staff row was still repointed - the merge steps applied fine, it's only the
    // final delete that the leftover reference blocked.
    expect(tables.get("event_staff")).toContainEqual(expect.objectContaining({ id: "es-1", person_id: "person-1" }));
    expect(tables.get("people")).toContainEqual(expect.objectContaining({ id: "person-2" }));
    const findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toEqual([expect.objectContaining({ id: "finding-1", status: "open" })]);
  });

  it("completes a half-applied merge on rerun, after a crash mid-merge leaves the finding approved", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [person("person-1"), person("person-2")],
      participants: [{ id: "part-2", person_id: "person-2" }],
      medical_profiles: [
        {
          id: "mp-dup",
          person_id: "person-2",
          allergies: "peanuts",
          medications: null,
          conditions: null,
          physician_name: null,
          physician_phone: null,
          last_tetanus: null,
          weight: null,
        },
      ],
      audit_findings: [duplicatePersonFinding({ subject: "person-1", detail: GROUP_DETAIL })],
    });

    // A write failure partway through the first run's steps - after participants relink (which
    // comes first in the plan), but before the medical_profiles repoint.
    let crashed = false;
    const crashingFetch = vi.fn(async (url: string, init?: FetchInit) => {
      const method = init?.method ?? "GET";
      const collection = new URL(url).pathname.split("/")[2];
      if (method === "PATCH" && collection === "medical_profiles" && !crashed) {
        crashed = true;
        throw new Error("simulated crash");
      }
      return fetchMock(url, init);
    });
    vi.stubGlobal("fetch", crashingFetch);
    const directus = new DirectusClient(baseUrl, token);

    await expect(runApprovedPersonMerges(directus)).rejects.toThrow("simulated crash");

    expect(tables.get("participants")).toContainEqual(expect.objectContaining({ id: "part-2", person_id: "person-1" }));
    expect(tables.get("medical_profiles")).toContainEqual(
      expect.objectContaining({ id: "mp-dup", person_id: "person-2" }),
    );
    let findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toEqual([expect.objectContaining({ id: "finding-1", status: "approved" })]);

    const result = await runApprovedPersonMerges(directus);

    expect(result).toEqual({ mergesApplied: 1, mergesSkipped: 0 });
    expect(tables.get("people")).toEqual([expect.objectContaining({ id: "person-1" })]);
    expect(tables.get("medical_profiles")).toEqual([expect.objectContaining({ id: "mp-dup", person_id: "person-1" })]);
    findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toEqual([expect.objectContaining({ id: "finding-1", status: "resolved" })]);
  });

  it("doesn't let one finding's unexpected failure stop a later finding in the same run", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [
        person("person-1", { first_name: "Jane", last_name: "Doe" }),
        person("person-2", { first_name: "Jane", last_name: "Doe" }),
        person("person-3", { first_name: "John", last_name: "Smith" }),
        person("person-4", { first_name: "John", last_name: "Smith" }),
      ],
      participants: [
        { id: "part-2", person_id: "person-2" },
        { id: "part-4", person_id: "person-4" },
      ],
      audit_findings: [
        duplicatePersonFinding({ id: "finding-a", subject: "person-1", detail: GROUP_DETAIL }),
        duplicatePersonFinding({
          id: "finding-b",
          subject: "person-3",
          detail: "John Smith: person-3 (dob unknown), person-4 (dob unknown)",
        }),
      ],
    });

    // Fails only finding-a's write - its participant relink, the plan's first step - leaving
    // finding-b's merge untouched.
    const crashingFetch = vi.fn(async (url: string, init?: FetchInit) => {
      const method = init?.method ?? "GET";
      const [, , collection, id] = new URL(url).pathname.split("/");
      if (method === "PATCH" && collection === "participants" && id === "part-2") {
        throw new Error("simulated crash for finding-a");
      }
      return fetchMock(url, init);
    });
    vi.stubGlobal("fetch", crashingFetch);
    const directus = new DirectusClient(baseUrl, token);

    await expect(runApprovedPersonMerges(directus)).rejects.toThrow("simulated crash for finding-a");

    expect(tables.get("people")).toContainEqual(expect.objectContaining({ id: "person-3" }));
    expect(tables.get("people")).not.toContainEqual(expect.objectContaining({ id: "person-4" }));
    expect(tables.get("participants")).toContainEqual(expect.objectContaining({ id: "part-4", person_id: "person-3" }));

    const findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toContainEqual(expect.objectContaining({ id: "finding-a", status: "approved" }));
    expect(findings).toContainEqual(expect.objectContaining({ id: "finding-b", status: "resolved" }));
  });

  it("ignores open and dismissed duplicate_person findings", async () => {
    const { fetchMock, tables } = makeDirectusStore({
      people: [person("person-1"), person("person-2")],
      audit_findings: [
        duplicatePersonFinding({ id: "open-1", subject: "person-1", detail: GROUP_DETAIL, status: "open" }),
        duplicatePersonFinding({ id: "dismissed-1", subject: "person-1", detail: GROUP_DETAIL, status: "dismissed" }),
      ],
    });
    vi.stubGlobal("fetch", fetchMock);
    const directus = new DirectusClient(baseUrl, token);

    const result = await runApprovedPersonMerges(directus);

    expect(result).toEqual({ mergesApplied: 0, mergesSkipped: 0 });
    expect(tables.get("people")).toHaveLength(2);
    const findings = tables.get("audit_findings") as unknown as AuditFindingRow[];
    expect(findings).toEqual([
      expect.objectContaining({ id: "open-1", status: "open" }),
      expect.objectContaining({ id: "dismissed-1", status: "dismissed" }),
    ]);
  });
});
