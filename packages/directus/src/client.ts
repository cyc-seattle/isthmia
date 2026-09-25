import winston from "winston";

export const CREATE_CHUNK_SIZE = 250;

// This package's tsconfig (@tsconfig/node20, lib: es2023, no DOM) hits an @types/node quirk where
// the ambient `fetch`/`Response` types resolve to an empty structural type rather than undici's
// real one. Rather than cast at every call site, wrap `fetch` once with the shape we actually use.
export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export async function httpFetch(input: string, init?: RequestInit): Promise<HttpResponse> {
  return (await fetch(input, init)) as unknown as HttpResponse;
}

/** A single Directus REST filter, e.g. `{ email: { _eq: "a@b.com" } }`. */
export type DirectusFilter = Record<string, Record<string, string | number | boolean>>;

export interface ItemQuery {
  filter?: DirectusFilter;
  /** Row cap, or -1 for every row (the client pages through them transparently). */
  limit?: number;
  fields?: string[];
  sort?: string[];
}

// Directus caps a single page well below what "every row" needs, so `limit: -1` is paged internally
// at this size rather than trusting the server to hand back everything in one response.
const PAGE_SIZE = 500;

function filterToParams(filter: DirectusFilter): [string, string][] {
  const params: [string, string][] = [];
  for (const [field, operators] of Object.entries(filter)) {
    for (const [operator, value] of Object.entries(operators)) {
      params.push([`filter[${field}][${operator}]`, String(value)]);
    }
  }
  return params;
}

function queryToParams(query: ItemQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.filter) {
    for (const [key, value] of filterToParams(query.filter)) {
      params.set(key, value);
    }
  }
  if (query.fields) {
    params.set("fields", query.fields.join(","));
  }
  if (query.sort) {
    params.set("sort", query.sort.join(","));
  }
  return params;
}

export class DirectusClient {
  /**
   * @param dryRun When true, every write logs and returns what it would have sent instead of
   *   issuing the request. Reads always execute. Step 9's `--dry-run` CLI flag sets this.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly dryRun = false,
  ) {}

  /** Lets a caller that assigns its own placeholder ids for a dry run's id-less rows tell one apart from a real write failure. */
  get isDryRun(): boolean {
    return this.dryRun;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await httpFetch(`${this.baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`${method} ${path} -> ${res.status}: ${await res.text()}`);
    }
    return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
  }

  async readItems<T>(collection: string, query: ItemQuery = {}): Promise<T[]> {
    if (query.limit !== -1) {
      const params = queryToParams(query);
      if (query.limit !== undefined) {
        params.set("limit", String(query.limit));
      }
      const suffix = params.size > 0 ? `?${params}` : "";
      // A 204 (no matching rows) comes back as `undefined`, same as any other empty write response.
      const response = await this.request<{ data: T[] } | undefined>("GET", `/items/${collection}${suffix}`);
      return response?.data ?? [];
    }

    const items: T[] = [];
    for (let page = 1; ; page++) {
      const params = queryToParams(query);
      params.set("limit", String(PAGE_SIZE));
      params.set("page", String(page));
      const response = await this.request<{ data: T[] } | undefined>("GET", `/items/${collection}?${params}`);
      const rows = response?.data ?? [];
      items.push(...rows);
      if (rows.length < PAGE_SIZE) {
        return items;
      }
    }
  }

  async createItems<T>(collection: string, items: T[]): Promise<T[]> {
    if (this.dryRun) {
      winston.info("Dry run: skipping create", { collection, count: items.length });
      return items;
    }
    // Directus rejects an oversized body ("request entity too large"), so a bulk create is chunked.
    const created: T[] = [];
    for (let start = 0; start < items.length; start += CREATE_CHUNK_SIZE) {
      const chunk = items.slice(start, start + CREATE_CHUNK_SIZE);
      const response = await this.request<{ data: T[] }>("POST", `/items/${collection}`, chunk);
      created.push(...response.data);
    }
    return created;
  }

  async updateItem<T>(collection: string, id: string | number, patch: Partial<T>): Promise<T> {
    if (this.dryRun) {
      winston.info("Dry run: skipping update", { collection, id, fields: Object.keys(patch) });
      return patch as T;
    }
    const response = await this.request<{ data: T }>("PATCH", `/items/${collection}/${id}`, patch);
    return response.data;
  }

  // The sync never soft-deletes `session_classes` - it's a pure join with no status field of its
  // own (see docs/crm-schema.md) - so a class no longer offered by a session is removed outright.
  async deleteItem(collection: string, id: string | number): Promise<void> {
    if (this.dryRun) {
      winston.info("Dry run: skipping delete", { collection, id });
      return;
    }
    await this.request<undefined>("DELETE", `/items/${collection}/${id}`);
  }
}
