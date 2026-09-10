import { describe, it, expect, vi, afterEach } from "vitest";
import { applySchema, collectionsInSchema } from "../src/directus-client.js";

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

  it("applies the diff and succeeds when a re-diff afterward reports in sync", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: snapshot(["a"]) })) // GET /schema/snapshot
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: { hash: "abc", diff: { collections: [{ collection: "a", diff: [{ kind: "N" }] }] } },
        }),
      ) // POST /schema/diff
      .mockResolvedValueOnce(jsonResponse(204, undefined)) // POST /schema/apply
      .mockResolvedValueOnce(jsonResponse(204, undefined)); // re-diff: in sync (bare 204, see above)
    vi.stubGlobal("fetch", fetchMock);

    await expect(applySchema(baseUrl, token, snapshot(["a"]))).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(3, `${baseUrl}/schema/apply`, expect.anything());
    expect(fetchMock).toHaveBeenNthCalledWith(4, `${baseUrl}/schema/diff`, expect.anything());
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
      .mockResolvedValueOnce(jsonResponse(200, { data: pendingDiff })); // re-diff: still pending
    vi.stubGlobal("fetch", fetchMock);

    await expect(applySchema(baseUrl, token, snapshot(["a"]))).rejects.toThrow(/still reports pending changes/);

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
      .mockResolvedValueOnce(jsonResponse(204, undefined)); // re-diff: in sync (bare 204)
    vi.stubGlobal("fetch", fetchMock);

    await expect(applySchema(baseUrl, token, snapshot(["a"]))).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
