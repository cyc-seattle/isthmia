// A small REST client for Directus's own API — deliberately free of any `@pulumi/*` import so it's
// unit testable (see resources.ts, whose dynamic resource providers call into here; importing
// resources.ts itself isn't practical since its module-level imports pull in Pulumi).

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

/** Thrown by {@link directusRequest} on a non-2xx response, with `status` broken out so callers can
 * tell "not found" apart from a real failure without string-matching the message. */
export class DirectusHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DirectusHttpError";
    // Required, not cosmetic. Pulumi runs a dynamic provider in a separate process through its own
    // vendored ts-node, which downlevels `class ... extends Error` and breaks the prototype chain -
    // so `message` and `instanceof` are both lost on the way out. A real failure surfaced as
    // `error: undefined` until this line existed.
    Object.setPrototypeOf(this, DirectusHttpError.prototype);
    // Same reason, second half: `message` and `stack` are non-enumerable on Error, so Pulumi's
    // serialization of a thrown value across the provider boundary drops them and leaves an object
    // carrying only `status`. Redefining `message` as enumerable is what makes it survive.
    Object.defineProperty(this, "message", { value: message, enumerable: true, writable: true, configurable: true });
  }
}

/** True if `error` is a {@link DirectusHttpError} for a 404 — the shared "already gone" check every
 * tolerant delete uses to tell "not found" apart from a real failure. */
export function isNotFound(error: unknown): boolean {
  return error instanceof DirectusHttpError && error.status === 404;
}

/** True if `error` is a {@link DirectusHttpError} for a 403. Directus answers 403 rather than 404
 * for a `/users/{id}` that doesn't exist (see {@link userExists}), so a tolerant delete on `/users`
 * has to treat this the same as {@link isNotFound}. */
export function isForbidden(error: unknown): boolean {
  return error instanceof DirectusHttpError && error.status === 403;
}

function errorMessage(error: unknown): string | undefined {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.length > 0 ? message : undefined;
}

function errorStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

function errorStack(error: unknown): string | undefined {
  const stack = (error as { stack?: unknown } | null)?.stack;
  return typeof stack === "string" ? stack : undefined;
}

/**
 * Normalizes whatever a Directus dynamic-provider method throws into a plain `Error` with a
 * non-empty message, naming the provider and method that failed.
 *
 * A dynamic provider runs in a separate process through Pulumi's own vendored ts-node, which
 * downlevels `class ... extends Error` and can drop `message` on the way out (see
 * `DirectusHttpError` above) - and a bare `throw "reason"` or `throw undefined` loses everything
 * regardless. Call this at each provider method's outer boundary, after any internal handling
 * (e.g. `DirectusUser.update`'s 404 re-resolution) has already run its own `instanceof` checks on
 * the original error - this only sees whatever escapes that.
 */
export function describeProviderError(resource: string, method: string, error: unknown): Error {
  const message = errorMessage(error);
  const status = errorStatus(error);
  const stack = errorStack(error);
  const detail = message ?? (stack !== undefined ? `${String(error)}\n${stack}` : String(error));
  const withStatus = status !== undefined ? `${detail} (status ${status})` : detail;
  return new Error(`${resource}.${method} failed: ${withStatus}`);
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
    throw new DirectusHttpError(res.status, `${method} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

// --- Permission rows: individual rules attached to a policy (see resources.ts's
// DirectusPermissionRule). Permissions attach to the *policy*, not the role - (policy, collection,
// action) is a row's identity, so a create must check for one before posting a duplicate.

export type PermissionAction = "create" | "read" | "update" | "delete";

/** A permission row's content, once (policy, collection, action) already say which row it is. */
export interface PermissionRuleInput {
  collection: string;
  action: PermissionAction;
  /** A Directus permission filter (row-level rule), e.g. a $CURRENT_USER-scoped relational filter.
   * Omit for unrestricted access to the allowed fields. Requires a license on Directus 12+. */
  permissions?: Record<string, unknown>;
  /** Defaults to every field. */
  fields?: string[];
}

/** Creates a permission row under a policy and returns its id. Callers that must not duplicate a
 * still-live row should check {@link findPermission} first. */
export async function grantPermission(
  baseUrl: string,
  token: string,
  policyId: string,
  rule: PermissionRuleInput,
): Promise<string> {
  const res = await directusRequest<{ data: { id: number | string } }>(baseUrl, token, "POST", "/permissions", {
    policy: policyId,
    collection: rule.collection,
    action: rule.action,
    permissions: rule.permissions ?? {},
    fields: rule.fields ?? ["*"],
  });
  return String(res.data.id);
}

/** Deletes a permission row by id. A row that's already gone (e.g. `DirectusRole.delete` dropped
 * its policy first, taking every row under it along - those rows can live in a different stack's
 * state than the policy - or someone removed it by hand in the Data Studio) counts as success: a
 * delete exists to reach "this row is gone", and it already is. */
export async function deletePermission(baseUrl: string, token: string, permissionId: string): Promise<void> {
  try {
    await directusRequest(baseUrl, token, "DELETE", `/permissions/${permissionId}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

/**
 * Finds the permission row keyed by (policy, collection, action), or null if none exists yet.
 * {@link ensurePermission} uses this to adopt a row the old `DirectusRole` provider already created
 * for this key, instead of posting a duplicate - those rows outlive the code that made them, since
 * `DirectusRole` no longer clears or recreates them.
 */
export async function findPermission(
  baseUrl: string,
  token: string,
  policyId: string,
  collection: string,
  action: PermissionAction,
): Promise<string | null> {
  const res = await directusRequest<{ data: { id: number | string }[] }>(
    baseUrl,
    token,
    "GET",
    `/permissions?filter[policy][_eq]=${policyId}&filter[collection][_eq]=${collection}&filter[action][_eq]=${action}&limit=1`,
  );
  return res.data[0] !== undefined ? String(res.data[0].id) : null;
}

/** Overwrites a permission row's `permissions` filter and `fields` list to match `rule`. Shared by
 * `DirectusPermissionRule`'s `update` and by {@link ensurePermission}'s adopt path, which needs the
 * identical PATCH. */
export async function patchPermission(
  baseUrl: string,
  token: string,
  permissionId: string,
  rule: PermissionRuleInput,
): Promise<void> {
  await directusRequest(baseUrl, token, "PATCH", `/permissions/${permissionId}`, {
    permissions: rule.permissions ?? {},
    fields: rule.fields ?? ["*"],
  });
}

/**
 * PATCHes the permission row at `permissionId` to match `rule`, or recreates it under `policyId`
 * if that row no longer exists - the same "already gone" case {@link deletePermission} tolerates
 * (the policy was deleted out from under it, or someone removed it by hand). `DirectusPermissionRule`'s
 * `update` uses this instead of a bare `patchPermission` so state can repair itself on the next
 * `pulumi up` rather than failing forever.
 */
export async function reconcilePermission(
  baseUrl: string,
  token: string,
  policyId: string,
  permissionId: string,
  rule: PermissionRuleInput,
): Promise<string> {
  try {
    await patchPermission(baseUrl, token, permissionId, rule);
    return permissionId;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    return grantPermission(baseUrl, token, policyId, rule);
  }
}

/**
 * Returns the id of the permission row for (policyId, collection, action) declared by `rule`,
 * creating it if absent. Adopting a pre-existing row (e.g. one `DirectusRole` created before
 * permission rules became their own resource) only confirms its identity, not that its content
 * matches `rule` - unlike `update`, `create` has no prior recorded state to diff against, so an
 * adopted row must be reconciled immediately. Skipping that would let Pulumi record the declared
 * inputs as this resource's state while Directus quietly holds something else, with no later
 * `pulumi up` able to notice or correct it.
 */
export async function ensurePermission(
  baseUrl: string,
  token: string,
  policyId: string,
  rule: PermissionRuleInput,
): Promise<string> {
  const existing = await findPermission(baseUrl, token, policyId, rule.collection, rule.action);
  if (existing !== null) {
    await patchPermission(baseUrl, token, existing, rule);
    return existing;
  }
  return grantPermission(baseUrl, token, policyId, rule);
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

// The shape mergeSchemas needs beyond DirectusSnapshotEntry: a field or relation's own `field` name,
// to detect two schemas declaring the same collection's same field. `DirectusSnapshotEntry` stays
// collection-only because that's all scopeSnapshot needs post-merge.
interface DirectusFieldEntry extends DirectusSnapshotEntry {
  field: string;
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
 * `crm/index.ts`'s Staff permission rules) that need the same list for something else, so
 * it's never a hand-maintained array that can drift from `schema.yaml` (see #109).
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
 * Concatenates every package's own schema snapshot - `collections`, `fields`, and `relations` each
 * - into the one complete, authoritative snapshot `applySchema` applies. Merging up front, rather
 * than applying each package's schema in its own `scopeSnapshot` pass, is what lets a canonical
 * package's apply delete a field a provider stopped declaring: with a single merged snapshot every
 * declared collection has exactly one owner, so there is no round-trip in which one package's apply
 * can drop a field another package owns.
 *
 * Two schemas declaring the same collection, or the same collection's same field, is a programming
 * error, not a last-write-wins - this throws, naming both packages, rather than silently keeping
 * one of them.
 */
export function mergeSchemas(schemas: { name: string; schema: unknown }[]): unknown {
  const typed = schemas.map(({ name, schema }) => ({ name, schema: schema as DirectusSnapshot }));

  const collections: DirectusSnapshotEntry[] = [];
  const fields: DirectusFieldEntry[] = [];
  const relations: DirectusFieldEntry[] = [];
  const collectionOwners = new Map<string, string>();
  const fieldOwners = new Map<string, string>();

  for (const { name, schema } of typed) {
    for (const collection of schema.collections) {
      const owner = collectionOwners.get(collection.collection);
      if (owner !== undefined) {
        throw new Error(`mergeSchemas: collection "${collection.collection}" is declared by both ${owner} and ${name}`);
      }
      collectionOwners.set(collection.collection, name);
      collections.push(collection);
    }
    for (const field of schema.fields as DirectusFieldEntry[]) {
      const key = `${field.collection}.${field.field}`;
      const owner = fieldOwners.get(key);
      if (owner !== undefined) {
        throw new Error(`mergeSchemas: field "${key}" is declared by both ${owner} and ${name}`);
      }
      fieldOwners.set(key, name);
      fields.push(field);
    }
    relations.push(...(schema.relations as DirectusFieldEntry[]));
  }

  const first = typed[0]?.schema;
  return {
    version: first?.version ?? 1,
    directus: first?.directus ?? "",
    vendor: first?.vendor ?? "",
    collections,
    fields,
    relations,
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
 * `schema` here is every package's own schema.yaml already merged into one snapshot (see
 * `mergeSchemas`), applied together in a single call. `/schema/diff` diffs whatever it's given
 * against the *whole instance*, so posting a bare app schema gets read as "delete every collection
 * this snapshot doesn't mention" - confirmed hands-on against a throwaway instance, `/schema/apply`
 * really does drop the collection and its data. So before diffing, this fetches the live instance
 * snapshot and merges `schema`'s own collections/fields/relations onto it (`scopeSnapshot`),
 * leaving every collection nothing declares exactly as it lives today. Do not go back to diffing
 * the bare `schema` - that's the bug #109 fixed.
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

// --- Users. Directus enforces a unique email, so a user this program should own may already
// exist: after a Pulumi resource rename, after a state loss, or because someone provisioned the
// account by hand. Posting blindly fails the whole apply with RECORD_NOT_UNIQUE, so find first.

export interface DirectusUserFields {
  email: string;
  role: string;
  status: string;
  provider: string;
  // `| undefined` explicitly: this package sets exactOptionalPropertyTypes, and the caller builds
  // these straight from optional resource inputs.
  external_identifier?: string | undefined;
  token?: string | undefined;
}

export async function findUserByEmail(baseUrl: string, token: string, email: string): Promise<string | undefined> {
  const found = await directusRequest<{ data: { id: string }[] } | undefined>(
    baseUrl,
    token,
    "GET",
    `/users?filter[email][_eq]=${encodeURIComponent(email)}&fields=id&limit=1`,
  );
  return found?.data?.[0]?.id;
}

/**
 * Creates the user, or adopts the existing one with that email and reconciles it to `fields`.
 *
 * Reports which happened, because the caller must not delete an account it merely adopted: two
 * resources can name the same person (a rename creates one and destroys the other), and a delete
 * that does not check would take a live login with it.
 */
export async function upsertUserByEmail(
  baseUrl: string,
  token: string,
  fields: DirectusUserFields,
): Promise<{ userId: string; adopted: boolean }> {
  const existing = await findUserByEmail(baseUrl, token, fields.email);
  if (existing) {
    await directusRequest(baseUrl, token, "PATCH", `/users/${existing}`, fields);
    return { userId: existing, adopted: true };
  }
  const created = await directusRequest<{ data: { id: string } }>(baseUrl, token, "POST", "/users", fields);
  return { userId: created.data.id, adopted: false };
}

async function userExists(baseUrl: string, token: string, userId: string): Promise<boolean> {
  try {
    await directusRequest(baseUrl, token, "GET", `/users/${userId}?fields=id`);
    return true;
  } catch (error) {
    // Directus answers 403 rather than 404 for a user id that is not there, even to an admin - it
    // will not confirm existence either way. A caller that just authenticated and can list users
    // therefore reads both as absent; a real credential failure surfaces on the next request.
    if (!isNotFound(error) && !isForbidden(error)) throw error;
    return false;
  }
}

/**
 * PATCHes the user at `staleId` to `fields`, or — if that id no longer exists — resolves it by email
 * instead, via {@link upsertUserByEmail}.
 *
 * Verifies with a GET before patching, rather than patching and catching a failure: Directus
 * validates a PATCH's body before checking whether the target row exists, so a PATCH to a dead id
 * whose `email` collides with a different live row returns 400 `RECORD_NOT_UNIQUE`, not 404 - the
 * same status a genuinely malformed payload returns. Catching 400 and re-resolving on it would risk
 * turning a real bug into a silent adoption of the wrong row; checking existence up front avoids
 * needing to tell those two cases apart. `priorAdopted` carries forward unchanged when `staleId` is
 * still live, since patching in place doesn't change who owns the account.
 */
export async function reconcileUser(
  baseUrl: string,
  token: string,
  staleId: string,
  priorAdopted: boolean | undefined,
  fields: DirectusUserFields,
): Promise<{ userId: string; adopted: boolean | undefined }> {
  if (await userExists(baseUrl, token, staleId)) {
    await directusRequest(baseUrl, token, "PATCH", `/users/${staleId}`, fields);
    return { userId: staleId, adopted: priorAdopted };
  }
  return upsertUserByEmail(baseUrl, token, fields);
}
