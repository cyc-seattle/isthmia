import { describe, expect, it, vi, afterEach } from "vitest";
import { dryRunAuthentikClient, HttpAuthentikClient } from "../src/authentik.js";

type FetchInit = { method?: string; headers?: unknown; body?: unknown };

const baseUrl = "https://login.example.com";
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

describe("HttpAuthentikClient.findUserByEmail", () => {
  it("returns the matching user, case-insensitively", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { results: [{ pk: 7, username: "a@example.com", email: "A@Example.com" }] }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpAuthentikClient(baseUrl, token);

    const user = await client.findUserByEmail("a@example.com");

    expect(user).toEqual({ pk: "7", username: "a@example.com", email: "A@Example.com" });
    const [url, init] = fetchMock.mock.calls[0] as [string, FetchInit];
    expect(url).toBe(`${baseUrl}/api/v3/core/users/?email=a%40example.com`);
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${token}`);
  });

  it("returns null when no user matches", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [] })));
    const client = new HttpAuthentikClient(baseUrl, token);

    expect(await client.findUserByEmail("nobody@example.com")).toBeNull();
  });
});

describe("HttpAuthentikClient.createUser", () => {
  it("creates an internal user with the email as username and no password", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, { pk: 9, username: "a@example.com", email: "a@example.com" }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpAuthentikClient(baseUrl, token);

    const user = await client.createUser("a@example.com");

    expect(user).toEqual({ pk: "9", username: "a@example.com", email: "a@example.com" });
    const [, init] = fetchMock.mock.calls[0] as [string, FetchInit];
    const body = JSON.parse(init.body as unknown as string);
    expect(body).toEqual({
      username: "a@example.com",
      name: "a@example.com",
      email: "a@example.com",
      type: "internal",
      is_active: true,
    });
    expect(body.password).toBeUndefined();
  });
});

describe("HttpAuthentikClient.getGroup", () => {
  it("returns the group's pk and its members", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        jsonResponse(200, {
          results: [{ pk: "group-pk", users_obj: [{ pk: 1, username: "a@example.com", email: "a@example.com" }] }],
        }),
      ),
    );
    const client = new HttpAuthentikClient(baseUrl, token);

    const group = await client.getGroup("staff");

    expect(group).toEqual({
      pk: "group-pk",
      members: [{ pk: "1", username: "a@example.com", email: "a@example.com" }],
    });
  });

  it("returns null when the group doesn't exist", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse(200, { results: [] })));
    const client = new HttpAuthentikClient(baseUrl, token);

    expect(await client.getGroup("missing")).toBeNull();
  });
});

describe("HttpAuthentikClient.setGroupMembers", () => {
  it("PATCHes the group's users field with numeric pks", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);
    const client = new HttpAuthentikClient(baseUrl, token);

    await client.setGroupMembers("group-pk", ["1", "2"]);

    const [url, init] = fetchMock.mock.calls[0] as [string, FetchInit];
    expect(url).toBe(`${baseUrl}/api/v3/core/groups/group-pk/`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as unknown as string)).toEqual({ users: [1, 2] });
  });
});

describe("dryRunAuthentikClient", () => {
  it("skips creating a user and reports a placeholder instead", async () => {
    const real = new HttpAuthentikClient(baseUrl, token);
    const dryRun = dryRunAuthentikClient(real);

    const user = await dryRun.createUser("a@example.com");

    expect(user.email).toBe("a@example.com");
  });

  it("skips setting group members with no request made", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const real = new HttpAuthentikClient(baseUrl, token);
    const dryRun = dryRunAuthentikClient(real);

    await dryRun.setGroupMembers("group-pk", ["1"]);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
