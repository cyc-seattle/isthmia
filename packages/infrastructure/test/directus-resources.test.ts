import { describe, it, expect, vi, afterEach } from "vitest";
import { omitUndefined, directusRoleProvider, directusUserProvider } from "../src/directus/resources.js";
import { describeProviderError, DirectusHttpError } from "../src/directus/client.js";

const baseUrl = "https://directus.example.com";

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

function stubLogin(fetchMock: ReturnType<typeof vi.fn>) {
  fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { access_token: "test-token" } })); // POST /auth/login
}

const auth = { baseUrl, adminEmail: "admin@example.com", adminPassword: "hunter2" };

describe("omitUndefined", () => {
  it("drops keys whose value is undefined", () => {
    expect(omitUndefined({ a: 1, b: undefined, c: "x" })).toEqual({ a: 1, c: "x" });
  });

  it("keeps null and falsy-but-defined values", () => {
    expect(omitUndefined({ a: null, b: false, c: 0, d: "" })).toEqual({ a: null, b: false, c: 0, d: "" });
  });

  it("leaves an object with no undefined values unchanged", () => {
    const obj = { a: 1, b: "x" };
    expect(omitUndefined(obj)).toEqual(obj);
  });
});

describe("describeProviderError", () => {
  it("carries a plain Error's message, tagged with the resource and method", () => {
    const result = describeProviderError("DirectusRole", "create", new Error("boom"));
    expect(result.message).toContain("DirectusRole.create");
    expect(result.message).toContain("boom");
  });

  it("carries a DirectusHttpError's message and status", () => {
    const result = describeProviderError("DirectusUser", "update", new DirectusHttpError(404, "not found"));
    expect(result.message).toContain("not found");
    expect(result.message).toContain("404");
  });

  it("falls back to String(error) for an object with no message", () => {
    const result = describeProviderError("DirectusPermissionRule", "diff", { foo: "bar" });
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).toContain("DirectusPermissionRule.diff");
  });

  it("falls back to String(error) for a thrown undefined — the case that was previously invisible", () => {
    const result = describeProviderError("DirectusAdminAccessGrant", "delete", undefined);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).toContain("DirectusAdminAccessGrant.delete");
  });
});

describe("DirectusRole.delete", () => {
  const props = { ...auth, name: "Staff", appAccess: true, roleId: "role-1", policyId: "policy-1" };

  it("treats an already-gone access row, role, and policy as success (#125)", async () => {
    const fetchMock = vi.fn();
    stubLogin(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [{ id: "access-1" }] })); // GET /access
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { errors: [{ message: "not found" }] })); // DELETE /access/access-1
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { errors: [{ message: "not found" }] })); // DELETE /roles/role-1
    fetchMock.mockResolvedValueOnce(jsonResponse(204, undefined)); // DELETE /policies/policy-1
    vi.stubGlobal("fetch", fetchMock);

    await expect(directusRoleProvider.delete?.("role-1", props)).resolves.toBeUndefined();
  });

  it("still throws on a non-404 failure", async () => {
    const fetchMock = vi.fn();
    stubLogin(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: [] })); // GET /access: none
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { errors: [{ message: "forbidden" }] })); // DELETE /roles/role-1
    vi.stubGlobal("fetch", fetchMock);

    await expect(directusRoleProvider.delete?.("role-1", props)).rejects.toThrow(/403/);
  });
});

describe("DirectusRole with a fixed ID", () => {
  it("creates the role with that ID", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: "pong" })); // GET /server/ping
    stubLogin(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { id: "policy-1" } })); // POST /policies
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { id: "role-1" } })); // POST /roles
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { id: 1 } })); // POST /access
    vi.stubGlobal("fetch", fetchMock);

    const result = await directusRoleProvider.create({
      ...auth,
      name: "Community",
      appAccess: false,
      fixedRoleId: "role-1",
    });

    const [, rolesInit] = fetchMock.mock.calls[3] as [string, { body: string }];
    expect(JSON.parse(rolesInit.body)).toMatchObject({ id: "role-1", name: "Community" });
    expect(result).toMatchObject({ id: "role-1", outs: { roleId: "role-1", policyId: "policy-1" } });
  });

  it("creates a role without one with no ID", async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: "pong" }));
    stubLogin(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { id: "policy-1" } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { id: "role-2" } }));
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { id: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    await directusRoleProvider.create({ ...auth, name: "Staff", appAccess: true });

    const [, rolesInit] = fetchMock.mock.calls[3] as [string, { body: string }];
    expect(JSON.parse(rolesInit.body)).not.toHaveProperty("id");
  });
});

describe("DirectusRole.diff", () => {
  const olds = { ...auth, name: "Staff", appAccess: true, roleId: "role-1", policyId: "policy-1" };

  it("ignores the provider's own code, so editing it updates no role", async () => {
    const news = { ...auth, name: "Staff", appAccess: true, __provider: "edited" };
    await expect(directusRoleProvider.diff?.("role-1", olds, news)).resolves.toEqual({ changes: false, replaces: [] });
  });

  it("updates a renamed role in place", async () => {
    const news = { ...auth, name: "Staff 2", appAccess: true };
    await expect(directusRoleProvider.diff?.("role-1", olds, news)).resolves.toEqual({ changes: true, replaces: [] });
  });

  it("replaces a role whose fixed ID changes", async () => {
    const news = { ...auth, name: "Staff", appAccess: true, fixedRoleId: "role-2" };
    await expect(directusRoleProvider.diff?.("role-1", olds, news)).resolves.toEqual({
      changes: true,
      replaces: ["fixedRoleId"],
    });
  });
});

describe("DirectusUser.diff", () => {
  const olds = { ...auth, email: "a@b.com", roleId: "role-1", provider: "authentik", userId: "user-1" };

  it("ignores the provider's own code", async () => {
    const news = { ...auth, email: "a@b.com", roleId: "role-1", provider: "authentik", __provider: "edited" };
    await expect(directusUserProvider.diff?.("user-1", olds, news)).resolves.toEqual({ changes: false });
  });

  it("updates a user whose role changes", async () => {
    const news = { ...auth, email: "a@b.com", roleId: "role-2", provider: "authentik" };
    await expect(directusUserProvider.diff?.("user-1", olds, news)).resolves.toEqual({ changes: true });
  });
});

describe("DirectusUser.delete", () => {
  const props = { ...auth, email: "a@b.com", roleId: "role-1", provider: "google", userId: "user-1", adopted: false };

  it("treats an already-gone user as success (#125)", async () => {
    const fetchMock = vi.fn();
    stubLogin(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { errors: [{ message: "not found" }] })); // DELETE /users/user-1
    vi.stubGlobal("fetch", fetchMock);

    await expect(directusUserProvider.delete?.("user-1", props)).resolves.toBeUndefined();
  });

  it("treats a 403 as success, since Directus answers 403 rather than 404 for a missing user (#125)", async () => {
    const fetchMock = vi.fn();
    stubLogin(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(403, { errors: [{ message: "forbidden" }] })); // DELETE /users/user-1
    vi.stubGlobal("fetch", fetchMock);

    await expect(directusUserProvider.delete?.("user-1", props)).resolves.toBeUndefined();
  });

  it("still throws on a non-404/403 failure", async () => {
    const fetchMock = vi.fn();
    stubLogin(fetchMock);
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { errors: [{ message: "server error" }] })); // DELETE /users/user-1
    vi.stubGlobal("fetch", fetchMock);

    await expect(directusUserProvider.delete?.("user-1", props)).rejects.toThrow(/500/);
  });
});
