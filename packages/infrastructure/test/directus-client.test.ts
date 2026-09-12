import { describe, it, expect, vi, afterEach } from "vitest";
import {
  applySchema,
  collectionsInSchema,
  waitForReachable,
  DEFAULT_REACHABLE_TIMEOUT_MS,
  grantPermission,
  deletePermission,
  findPermission,
} from "../src/directus/client.js";

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

// A minimal but shape-complete snapshot, as returned by GET /schema/snapshot and expected by
// POST /schema/diff. Keyed the way applySchema's merge logic keys collections/fields/relations: by
// each entry's own `collection` field.
function snapshot(collections: string[], fields: string[] = [], relations: string[] = []) {
  return {
    version: 1,
    directus: "12.3.1",
    vendor: "postgres",
    collections: collections.map((collection) => ({ collection })),
    fields: fields.map((collection) => ({ collection })),
    relations: relations.map((collection) => ({ collection })),
  };
}

describe("collectionsInSchema", () => {
  it("derives the collection name list from a schema snapshot's own collections array", () => {
    expect(collectionsInSchema(snapshot(["people", "contacts"]))).toEqual(["people", "contacts"]);
  });
});

describe("applySchema", () => {
  it("does nothing when the diff (against the merged snapshot) reports already in sync", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: snapshot(["a"]) })) // GET /schema/snapshot
      // Real Directus returns a bare 204 (no body) for "already in sync" - not `200 { data: null }`
      // (found while verifying #109 against a real instance; see schemaDiff's comment).
      .mockResolvedValueOnce(jsonResponse(204, undefined)); // POST /schema/diff: in sync
    vi.stubGlobal("fetch", fetchMock);

    await applySchema(baseUrl, token, snapshot(["a"]));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, `${baseUrl}/schema/snapshot`, expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${baseUrl}/schema/diff`, expect.anything());
  });

  it("applies the diff and succeeds once the collections exist afterward", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: snapshot(["a"]) })) // GET /schema/snapshot
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: { hash: "abc", diff: { collections: [{ collection: "a", diff: [{ kind: "N" }] }] } },
        }),
      ) // POST /schema/diff
      .mockResolvedValueOnce(jsonResponse(204, undefined)) // POST /schema/apply
      .mockResolvedValueOnce(jsonResponse(200, { data: snapshot(["a"]) })); // verify: collection exists
    vi.stubGlobal("fetch", fetchMock);

    await expect(applySchema(baseUrl, token, snapshot(["a"]))).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(3, `${baseUrl}/schema/apply`, expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(4, `${baseUrl}/schema/snapshot`, expect.anything());
  });

  it("throws instead of silently succeeding when the apply didn't actually take", async () => {
    // Regression test: a live `pulumi up` once recorded this as a successful create even though
    // the collections never existed - /schema/apply returned 204 but didn't persist the change.
    const pendingDiff = { hash: "abc", diff: { collections: [{ collection: "a", diff: [{ kind: "N" }] }] } };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: snapshot(["a"]) })) // GET /schema/snapshot
      .mockResolvedValueOnce(jsonResponse(200, { data: pendingDiff })) // POST /schema/diff
      .mockResolvedValueOnce(jsonResponse(204, undefined)) // POST /schema/apply (silently a no-op)
      .mockResolvedValueOnce(jsonResponse(200, { data: snapshot([]) })); // verify: collection still absent
    vi.stubGlobal("fetch", fetchMock);

    await expect(applySchema(baseUrl, token, snapshot(["a"]))).rejects.toThrow(/do not exist afterward/);

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("scopes the diff to this app's own collections: a collection outside this app's schema is preserved", async () => {
    // Regression test for #109: applySchema used to diff the bare app schema against the whole
    // instance, so a collection belonging to another app (not mentioned in this app's schema.yaml)
    // was proposed for deletion. The live instance here has "a" (this app's) and "other_app_thing"
    // (someone else's); this app's schema only declares "a".
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: snapshot(["a", "other_app_thing"]) })) // GET /schema/snapshot
      .mockResolvedValueOnce(jsonResponse(204, undefined)); // POST /schema/diff: in sync (bare 204)
    vi.stubGlobal("fetch", fetchMock);

    await applySchema(baseUrl, token, snapshot(["a"]));

    const diffCall = fetchMock.mock.calls[1] as [string, { body: string }];
    const postedSnapshot = JSON.parse(diffCall[1].body) as ReturnType<typeof snapshot>;
    const postedCollections = postedSnapshot.collections.map((c) => c.collection);
    expect(postedCollections).toContain("other_app_thing");
    expect(postedCollections).toContain("a");
  });

  it("preserves (does not delete) a collection dropped from this app's own schema.yaml", async () => {
    // Deliberate choice (#109), not a gap: deriving "owned" from the new schema.yaml alone means a
    // collection this app used to declare but has since removed is no longer in `owned`, so it's
    // never dropped from the live half of the merge and never re-added from the app schema either -
    // it's preserved as-is. Automated collection deletion isn't supported; dropping a collection is
    // a deliberate manual operation. (Field-level removals within a still-owned collection do still
    // apply - see the defense-in-depth test below, which covers the boundary from the other side.)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: snapshot(["a", "b"]) })) // GET /schema/snapshot: app used to own "b" too
      .mockResolvedValueOnce(jsonResponse(204, undefined)); // POST /schema/diff: in sync (bare 204)
    vi.stubGlobal("fetch", fetchMock);

    await applySchema(baseUrl, token, snapshot(["a"])); // "b" no longer in this app's schema.yaml

    const diffCall = fetchMock.mock.calls[1] as [string, { body: string }];
    const postedSnapshot = JSON.parse(diffCall[1].body) as ReturnType<typeof snapshot>;
    expect(postedSnapshot.collections.map((c) => c.collection)).toContain("b");
  });

  it("derives the owned-collection set from the schema argument alone, not a separate parameter", () => {
    // applySchema takes (baseUrl, token, schema) - three parameters, full stop. There is no fourth
    // "owned collections" parameter to pass separately (and therefore no way for it to drift from
    // schema.yaml - see #109's "never a hand-maintained parallel list").
    expect(applySchema.length).toBe(3);
  });

  it("throws rather than applying if the diff proposes a collection-level delete", async () => {
    // Defense in depth (#109): scopeSnapshot should make a collection-level delete impossible, since
    // the merged snapshot always contains every live collection this app doesn't own. If one shows
    // up anyway - a bug in scopeSnapshot, or some other caller diffing an unscoped snapshot - refuse
    // to apply rather than trusting the merge blindly.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: snapshot(["a"]) })) // GET /schema/snapshot
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: { hash: "abc", diff: { collections: [{ collection: "other_app_thing", diff: [{ kind: "D" }] }] } },
        }),
      ); // POST /schema/diff: proposes deleting a collection
    vi.stubGlobal("fetch", fetchMock);

    await expect(applySchema(baseUrl, token, snapshot(["a"]))).rejects.toThrow(/collection-level delete/);

    // Never reaches /schema/apply.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not mistake a metadata change on an owned collection for a collection-level delete", async () => {
    // Regression test: found live while re-verifying the fix against a real Directus instance.
    // deep-diff reports a "D" kind both for a whole collections-array element with no match (an
    // actual collection deletion, `{ kind: "D", lhs: <whole object> }`, no `path`) and for a single
    // dropped key within a *matched* collection's own metadata (`{ kind: "D", path: [...], lhs: ...
    // }` - e.g. this app's schema.yaml simply not repeating a default `note: null`). Only the first
    // is a real deletion; the second is ordinary metadata drift on a collection this app still owns
    // and still declares, and must not be blocked.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: snapshot(["a"]) })) // GET /schema/snapshot
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: {
            hash: "abc",
            diff: {
              collections: [{ collection: "a", diff: [{ kind: "D", path: ["meta", "note"], lhs: "old note" }] }],
            },
          },
        }),
      ) // POST /schema/diff: a matched collection's metadata changed, not a deletion
      .mockResolvedValueOnce(jsonResponse(204, undefined)) // POST /schema/apply
      .mockResolvedValueOnce(jsonResponse(200, { data: snapshot(["a"]) })); // verify: collection exists
    vi.stubGlobal("fetch", fetchMock);

    await expect(applySchema(baseUrl, token, snapshot(["a"]))).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("waitForReachable", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately once /server/ping is reachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, {})));

    await expect(waitForReachable(baseUrl, 5_000)).resolves.toBeUndefined();
  });

  it("retries on a failed attempt (e.g. connection refused mid-VM-boot) and succeeds once reachable", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    const result = waitForReachable(baseUrl, 30_000);
    await vi.advanceTimersByTimeAsync(5_000); // the 5s retry sleep between attempts
    await expect(result).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a descriptive, actionable error once the timeout elapses with no success", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(503, {})));

    const result = waitForReachable(baseUrl, 10_000);
    const assertion = expect(result).rejects.toThrow(/did not become reachable within 10000ms.*re-run `pulumi up`/s);
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
  });
});

describe("DEFAULT_REACHABLE_TIMEOUT_MS", () => {
  it("is between 60s and 90s", () => {
    expect(DEFAULT_REACHABLE_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(DEFAULT_REACHABLE_TIMEOUT_MS).toBeLessThanOrEqual(90_000);
  });
});

describe("grantPermission", () => {
  it("posts the rule under the given policy and returns the new row's id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: { id: 42 } }));
    vi.stubGlobal("fetch", fetchMock);

    const permissionId = await grantPermission(baseUrl, token, "policy-1", {
      collection: "people",
      action: "read",
    });

    expect(permissionId).toBe("42");
    expect(fetchMock).toHaveBeenCalledWith(`${baseUrl}/permissions`, expect.objectContaining({ method: "POST" }));
    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as Record<string, unknown>;
    expect(body).toEqual({
      policy: "policy-1",
      collection: "people",
      action: "read",
      permissions: {},
      fields: ["*"],
    });
  });

  it("defaults permissions/fields but passes through an explicit filter and field list", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: { id: 7 } }));
    vi.stubGlobal("fetch", fetchMock);

    await grantPermission(baseUrl, token, "policy-1", {
      collection: "medical_profiles",
      action: "read",
      permissions: { person_id: { _eq: "$CURRENT_USER" } },
      fields: ["id", "notes"],
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body) as Record<string, unknown>;
    expect(body.permissions).toEqual({ person_id: { _eq: "$CURRENT_USER" } });
    expect(body.fields).toEqual(["id", "notes"]);
  });
});

describe("deletePermission", () => {
  it("deletes exactly the one row by id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(204, undefined));
    vi.stubGlobal("fetch", fetchMock);

    await deletePermission(baseUrl, token, "42");

    expect(fetchMock).toHaveBeenCalledWith(`${baseUrl}/permissions/42`, expect.objectContaining({ method: "DELETE" }));
  });
});

describe("findPermission", () => {
  it("returns the id of the row matching (policy, collection, action)", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: [{ id: 99 }] }));
    vi.stubGlobal("fetch", fetchMock);

    const permissionId = await findPermission(baseUrl, token, "policy-1", "people", "read");

    expect(permissionId).toBe("99");
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/permissions?filter[policy][_eq]=policy-1&filter[collection][_eq]=people&filter[action][_eq]=read&limit=1`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns null when no row matches yet, so the caller knows to create one", async () => {
    // The case that makes DirectusPermissionRule.create idempotent: on a brand-new (policy,
    // collection, action) key there's nothing to adopt, so it must fall through to grantPermission.
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, { data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(findPermission(baseUrl, token, "policy-1", "people", "read")).resolves.toBeNull();
  });
});
