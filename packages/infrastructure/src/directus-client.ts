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

export async function waitForReachable(baseUrl: string, timeoutMs = 180_000): Promise<void> {
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
  const res = await directusRequest<{ data: { hash: string; diff: unknown } | null }>(
    baseUrl,
    token,
    "POST",
    "/schema/diff",
    schema,
  );
  return res.data;
}

/**
 * Applies a schema snapshot via Directus's own `/schema/diff` + `/schema/apply` REST endpoints —
 * not the `directus schema apply` CLI. Going through the running server's own API instead of a
 * separate CLI process also sidesteps a real gotcha the CLI path has: the server's in-memory
 * schema cache doesn't otherwise notice the change until it restarts. Confirmed hands-on:
 * immediately after an API-driven apply, requests against the new collections succeed with no
 * restart.
 */
export async function applySchema(baseUrl: string, token: string, schema: unknown): Promise<void> {
  const diff = await schemaDiff(baseUrl, token, schema);
  if (!diff) return; // null = already in sync, nothing to apply
  await directusRequest(baseUrl, token, "POST", "/schema/apply", diff);
  // /schema/apply returning 204 doesn't actually guarantee Directus persisted every change (seen
  // live: a `pulumi up` recorded this as successful while the collections never actually existed) -
  // re-diff and fail loudly rather than silently reporting success on a schema that didn't take.
  const remaining = await schemaDiff(baseUrl, token, schema);
  if (remaining) {
    throw new Error(
      `/schema/apply returned successfully but /schema/diff still reports pending changes ` +
        `afterward - the schema did not actually take. Diff: ${JSON.stringify(remaining.diff)}`,
    );
  }
}
