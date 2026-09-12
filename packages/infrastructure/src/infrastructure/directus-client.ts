// A small REST client for Directus's own API — deliberately free of any `@pulumi/*` import so it's
// unit testable (see directus.ts, whose dynamic resource providers call into here; importing
// directus.ts itself isn't practical since its module-level code constructs real GCP/Pulumi
// resources on load).

// This package's tsconfig (@tsconfig/node20, lib: es2023, no DOM) hits an @types/node quirk where
// the ambient `fetch`/`Response` types resolve to an empty structural type rather than undici's
// real one (its conditional type meant to defer to DOM lib's Response misfires with no DOM lib
// present either). Rather than cast at every call site, wrap `fetch` once with the shape we
// actually use.
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export async function httpFetch(input: string, init?: RequestInit): Promise<HttpResponse> {
  return (await fetch(input, init)) as unknown as HttpResponse;
}

/** Default timeout for {@link waitForReachable}. Callers now `dependsOn` substrate-apply.ts, so this
 * is a safety net for container start/migration time, not a VM-boot budget (was 180s) - kept above
 * typical Directus startup so it doesn't reintroduce flaky applies. */
export const DEFAULT_REACHABLE_TIMEOUT_MS = 90_000;

export async function waitForReachable(baseUrl: string, timeoutMs = DEFAULT_REACHABLE_TIMEOUT_MS): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await httpFetch(`${baseUrl}/server/ping`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(
    `Directus at ${baseUrl} did not become reachable within ${timeoutMs}ms (VM boot/DNS/TLS may still be in ` +
      `progress — re-run \`pulumi up\` once it's up). Last error: ${String(lastError)}`,
  );
}

export async function login(baseUrl: string, email: string, password: string): Promise<string> {
  const res = await httpFetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    throw new Error(`Directus login as ${email} failed: ${res.status} ${await res.text()}`);
  }
  return ((await res.json()) as { data: { access_token: string } }).data.access_token;
}

export async function directusRequest<T>(
  baseUrl: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await httpFetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

async function schemaDiff(
  baseUrl: string,
  token: string,
  schema: unknown,
): Promise<{ hash: string; diff: unknown } | null> {
  // Found while verifying #109 against a real instance: when the submitted snapshot is already in
  // sync, Directus returns a bare `204 No Content` (empty body), not `200 { data: null }`.
  // `directusRequest`'s own 204 handling already turns that into `undefined` - treat it the same as
  // `{ data: null }` rather than crashing on `res.data`. Pre-existing bug, unrelated to #109's
  // cross-app-deletion issue, but on this exact function and newly reachable now that a scoped diff
  // can genuinely come back empty (pre-#109, an unscoped diff on a shared instance essentially
  // never did, since it always proposed deleting every other app's collections).
  const res = await directusRequest<{ data: { hash: string; diff: unknown } | null } | undefined>(
    baseUrl,
    token,
    "POST",
    "/schema/diff",
    schema,
  );
  return res?.data ?? null;
}

// The slice of a Directus schema snapshot (as returned by GET /schema/snapshot, and accepted by
// POST /schema/diff) that applySchema's scoping logic below needs to touch. Collections, fields, and
// relations are each keyed by their own `collection` field - for a relation that's the owning
// ("many") side, which is always a collection this app owns whenever this app owns the relation.
interface DirectusSnapshotEntry {
  collection: string;
}

interface DirectusSnapshot {
  version: number;
  directus: string;
  vendor: string;
  collections: DirectusSnapshotEntry[];
  fields: DirectusSnapshotEntry[];
  relations: DirectusSnapshotEntry[];
}

async function getSnapshot(baseUrl: string, token: string): Promise<DirectusSnapshot> {
  const res = await directusRequest<{ data: DirectusSnapshot }>(baseUrl, token, "GET", "/schema/snapshot");
  return res.data;
}

/**
 * The collection names an app's schema snapshot declares. This is the single derivation point for
 * "every collection this app owns" - used below to scope `applySchema`'s diff, and by callers (e.g.
 * `crm.ts`'s Staff permission rules) that need the same list for something else, so it's
 * never a hand-maintained array that can drift from `schema.yaml` (see #109).
 */
export function collectionsInSchema(schema: unknown): string[] {
  return (schema as DirectusSnapshot).collections.map((c) => c.collection);
}

/**
 * Merges an app's own schema onto the live instance's snapshot: for `collections`/`fields`/
 * `relations`, drops whatever the live snapshot has under a `collection` in `owned` and replaces it
 * with `appSchema`'s own entries; everything else in the live snapshot passes through untouched.
 *
 * See #109: this is what makes "this app's snapshot doesn't mention collection X" mean "leave X
 * alone" rather than "delete X" - `/schema/diff` itself has no such notion, it diffs the *entire
 * instance* against whatever it's given. Scoping to exactly what this app owns, plus everything
 * else exactly as it lives today, is the whole fix.
 *
 * A collection this app *used to* own but has since dropped from its own `schema.yaml` is not in
 * `owned` (owned always reflects the new schema, not the old one) - so it's preserved from the live
 * snapshot, not deleted. That's deliberate (see `applySchema`'s doc comment), not a gap.
 */
function scopeSnapshot(live: DirectusSnapshot, appSchema: DirectusSnapshot, owned: Set<string>): DirectusSnapshot {
  const keepLive = <T extends DirectusSnapshotEntry>(entries: T[]): T[] =>
    entries.filter((entry) => !owned.has(entry.collection));
  return {
    ...live,
    collections: [...keepLive(live.collections), ...appSchema.collections],
    fields: [...keepLive(live.fields), ...appSchema.fields],
    relations: [...keepLive(live.relations), ...appSchema.relations],
  };
}

/**
 * True if a `/schema/diff` response proposes deleting a collection outright.
 *
 * `deep-diff` (what `/schema/diff` uses under the hood) reports two shapes under `kind: "D"`:
 * a bare `{ kind: "D", lhs: <the whole collection object> }` with no `path`, when the entire
 * collections-array element has no match on the other side (i.e. the collection itself is being
 * deleted) - vs. `{ kind: "D", path: [...], lhs: ... }`, when a matched collection's own metadata
 * (e.g. its `note`) merely dropped a key. Only the former is an actual collection deletion; the
 * latter is ordinary metadata drift on a collection this app still owns and still declares. Verified
 * hands-on against a throwaway instance: submitting a snapshot that omits a collection produces the
 * first shape with no `path` at all.
 */
function hasCollectionDelete(diff: unknown): boolean {
  const collections =
    (diff as { collections?: { diff?: { kind?: string; path?: unknown }[] }[] } | undefined)?.collections ?? [];
  return collections.some((c) => (c.diff ?? []).some((entry) => entry.kind === "D" && entry.path === undefined));
}

/**
 * Applies a schema snapshot via Directus's own `/schema/diff` + `/schema/apply` REST endpoints —
 * not the `directus schema apply` CLI. Going through the running server's own API instead of a
 * separate CLI process also sidesteps a real gotcha the CLI path has: the server's in-memory
 * schema cache doesn't otherwise notice the change until it restarts. Confirmed hands-on:
 * immediately after an API-driven apply, requests against the new collections succeed with no
 * restart.
 *
 * Scoped diff (#109): there's one shared Directus instance across every app (see directus.ts) -
 * `schema` here is only ever *this* app's own schema.yaml. `/schema/diff` diffs whatever it's given
 * against the *whole instance*, so posting a bare app schema gets read as "delete every collection
 * this snapshot doesn't mention" - confirmed hands-on against a throwaway instance, `/schema/apply`
 * really does drop the collection and its data. So before diffing, this fetches the live instance
 * snapshot and merges `schema`'s own collections/fields/relations onto it (`scopeSnapshot`),
 * leaving every collection this app doesn't own exactly as it lives today. Do not go back to
 * diffing the bare `schema` - that's the bug #109 fixed.
 *
 * What this does and doesn't delete: a collection this app *used to* declare but has since dropped
 * from `schema.yaml` is preserved, not deleted - automated collection deletion isn't supported;
 * that's a deliberate manual operation. Field-level removals *within* a collection this app still
 * owns DO apply normally, including dropping the column and its data - that's ordinary schema
 * evolution, and it's scoped to collections this app declares, so it can never reach another app's
 * fields. As defense in depth against a bug in `scopeSnapshot` itself (rather than trusting the
 * merge blindly), this throws instead of applying if the diff ever proposes a collection-level
 * delete at all.
 *
 * Side effect worth knowing about: the merged snapshot's `version`/`directus`/`vendor` come from the
 * *live* instance, not from `schema`, so the version-drift check that motivated #101 can no longer
 * fire here. That's fine - it was only ever metadata - but noted so it isn't rediscovered later as a
 * regression.
 */
export async function applySchema(baseUrl: string, token: string, schema: unknown): Promise<void> {
  const appSchema = schema as DirectusSnapshot;
  const live = await getSnapshot(baseUrl, token);
  const owned = new Set(collectionsInSchema(appSchema));
  const merged = scopeSnapshot(live, appSchema, owned);

  const diff = await schemaDiff(baseUrl, token, merged);
  if (!diff) return; // null = already in sync, nothing to apply

  if (hasCollectionDelete(diff.diff)) {
    throw new Error(
      `/schema/diff proposed a collection-level delete even though the submitted snapshot was scoped ` +
        `to this app's own collections - that should be impossible (see applySchema's doc comment). ` +
        `Refusing to apply. Diff: ${JSON.stringify(diff.diff)}`,
    );
  }

  await directusRequest(baseUrl, token, "POST", "/schema/apply", diff);

  // A 204 from /schema/apply doesn't prove anything was persisted (seen live: an apply reported
  // success while the collections never existed), so verify. Check the collections are actually
  // there rather than that a re-diff is empty: Directus fills in collection metadata the committed
  // snapshot doesn't carry (`meta.status`, `meta.autosave_revision_interval` on 12.3.1), so a
  // re-diff is never empty and would fail every successful apply.
  const applied = await getSnapshot(baseUrl, token);
  const present = new Set(applied.collections.map((c) => c.collection));
  const missing = [...owned].filter((collection) => !present.has(collection));
  if (missing.length > 0) {
    throw new Error(
      `/schema/apply returned successfully but these collections do not exist afterward - the ` +
        `schema did not actually take: ${missing.join(", ")}`,
    );
  }
}
