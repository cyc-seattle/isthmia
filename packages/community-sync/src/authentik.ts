import winston from "winston";

// This package's tsconfig (@tsconfig/node20, no DOM lib) hits the same @types/node quirk
// `packages/directus/src/client.ts` works around: the ambient `fetch`/`Response` types resolve to
// an empty structural type rather than undici's real one, so the call is cast through this shape
// instead of at every call site.
interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

async function httpFetch(input: string, init?: RequestInit): Promise<HttpResponse> {
  return (await fetch(input, init)) as unknown as HttpResponse;
}

export interface AuthentikUser {
  pk: string;
  username: string;
  email: string;
}

export interface AuthentikGroup {
  pk: string;
  members: AuthentikUser[];
}

/**
 * The slice of Authentik's REST API the group passes write through - narrow enough that
 * `HttpAuthentikClient` satisfies it structurally, and narrow enough for a test to mock with no
 * live API. Both group passes create any missing user before they set membership; neither pass
 * creates a group - `staff` and `families` are created once, by the `authentik` Pulumi project.
 */
export interface AuthentikClient {
  findUserByEmail(email: string): Promise<AuthentikUser | null>;
  /** Creates an internal user with no password, keyed on the lowercased email as its username. */
  createUser(email: string): Promise<AuthentikUser>;
  /** Null if the named group doesn't exist yet - a configuration error this job doesn't recover from. */
  getGroup(name: string): Promise<AuthentikGroup | null>;
  /** Replaces a group's full membership list in one call, which is what lets a reconcile add and
   * remove members in a single write rather than two. */
  setGroupMembers(groupPk: string, userPks: readonly string[]): Promise<void>;
}

interface AuthentikApiUser {
  pk: number;
  username: string;
  email: string;
}

interface AuthentikApiGroup {
  pk: string;
  users_obj: AuthentikApiUser[];
}

function toUser(user: AuthentikApiUser): AuthentikUser {
  return { pk: String(user.pk), username: user.username, email: user.email };
}

/** Talks to Authentik's REST API (`/api/v3/core/...`) with a static bearer token, the way
 * `DirectusClient` talks to Directus - see `packages/directus/src/client.ts`. */
export class HttpAuthentikClient implements AuthentikClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

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

  async findUserByEmail(email: string): Promise<AuthentikUser | null> {
    const data = await this.request<{ results: AuthentikApiUser[] }>(
      "GET",
      `/api/v3/core/users/?email=${encodeURIComponent(email)}`,
    );
    const match = data.results.find((user) => user.email.toLowerCase() === email.toLowerCase());
    return match ? toUser(match) : null;
  }

  async createUser(email: string): Promise<AuthentikUser> {
    winston.info("Creating Authentik user", { email });
    const created = await this.request<AuthentikApiUser>("POST", "/api/v3/core/users/", {
      username: email,
      name: email,
      email,
      type: "internal",
      is_active: true,
    });
    return toUser(created);
  }

  async getGroup(name: string): Promise<AuthentikGroup | null> {
    const data = await this.request<{ results: AuthentikApiGroup[] }>(
      "GET",
      `/api/v3/core/groups/?name=${encodeURIComponent(name)}&include_users=true`,
    );
    const [group] = data.results;
    if (!group) {
      return null;
    }
    return { pk: group.pk, members: group.users_obj.map(toUser) };
  }

  async setGroupMembers(groupPk: string, userPks: readonly string[]): Promise<void> {
    await this.request("PATCH", `/api/v3/core/groups/${groupPk}/`, { users: userPks.map(Number) });
  }
}

/**
 * `AuthentikClient` has no built-in dry-run mode, unlike `DirectusClient` - this stands in for it
 * on a `--dry-run` run, logging the write instead of making it. Reads pass through to `real`, the
 * same way `gsuite-sync`'s dry run keeps live Google reads (see `directory-writer.ts`), so a dry
 * run can still report what a real one would find.
 */
export function dryRunAuthentikClient(real: AuthentikClient): AuthentikClient {
  return {
    findUserByEmail: (email) => real.findUserByEmail(email),
    getGroup: (name) => real.getGroup(name),
    async createUser(email) {
      winston.info("Dry run: skipping Authentik user create", { email });
      return { pk: `dry-run:${email}`, username: email, email };
    },
    async setGroupMembers(groupPk, userPks) {
      winston.info("Dry run: skipping Authentik group membership update", { groupPk, count: userPks.length });
    },
  };
}
