import { describe, expect, it, vi } from "vitest";
import { AuthentikClient, AuthentikUser } from "../src/authentik.js";
import { reconcileGroupMembership } from "../src/group-executor.js";

function user(pk: string, email: string): AuthentikUser {
  return { pk, username: email, email };
}

describe("reconcileGroupMembership", () => {
  it("creates a missing user and adds them to the group", async () => {
    const setGroupMembers = vi.fn().mockResolvedValue(undefined);
    const authentik: AuthentikClient = {
      getGroup: vi.fn().mockResolvedValue({ pk: "group-pk", members: [] }),
      findUserByEmail: vi.fn().mockResolvedValue(null),
      createUser: vi.fn().mockResolvedValue(user("new-pk", "new@example.com")),
      setGroupMembers,
    };

    const result = await reconcileGroupMembership(authentik, "staff", ["new@example.com"]);

    expect(authentik.createUser).toHaveBeenCalledWith("new@example.com");
    expect(setGroupMembers).toHaveBeenCalledWith("group-pk", ["new-pk"]);
    expect(result).toEqual({ added: 1, removed: 0, usersCreated: 1 });
  });

  it("reuses an existing user without creating a duplicate", async () => {
    const authentik: AuthentikClient = {
      getGroup: vi.fn().mockResolvedValue({ pk: "group-pk", members: [] }),
      findUserByEmail: vi.fn().mockResolvedValue(user("existing-pk", "existing@example.com")),
      createUser: vi.fn(),
      setGroupMembers: vi.fn().mockResolvedValue(undefined),
    };

    const result = await reconcileGroupMembership(authentik, "staff", ["existing@example.com"]);

    expect(authentik.createUser).not.toHaveBeenCalled();
    expect(authentik.setGroupMembers).toHaveBeenCalledWith("group-pk", ["existing-pk"]);
    expect(result.usersCreated).toBe(0);
  });

  it("removes a stale member no longer in the target set", async () => {
    const authentik: AuthentikClient = {
      getGroup: vi.fn().mockResolvedValue({
        pk: "group-pk",
        members: [user("stale-pk", "stale@example.com"), user("keep-pk", "keep@example.com")],
      }),
      findUserByEmail: vi.fn(),
      createUser: vi.fn(),
      setGroupMembers: vi.fn().mockResolvedValue(undefined),
    };

    const result = await reconcileGroupMembership(authentik, "families", ["keep@example.com"]);

    expect(authentik.setGroupMembers).toHaveBeenCalledWith("group-pk", ["keep-pk"]);
    expect(result).toEqual({ added: 0, removed: 1, usersCreated: 0 });
  });

  it("skips the write entirely when membership already matches", async () => {
    const authentik: AuthentikClient = {
      getGroup: vi.fn().mockResolvedValue({ pk: "group-pk", members: [user("pk1", "a@example.com")] }),
      findUserByEmail: vi.fn(),
      createUser: vi.fn(),
      setGroupMembers: vi.fn(),
    };

    const result = await reconcileGroupMembership(authentik, "staff", ["a@example.com"]);

    expect(authentik.setGroupMembers).not.toHaveBeenCalled();
    expect(result).toEqual({ added: 0, removed: 0, usersCreated: 0 });
  });

  it("throws when the named group doesn't exist", async () => {
    const authentik: AuthentikClient = {
      getGroup: vi.fn().mockResolvedValue(null),
      findUserByEmail: vi.fn(),
      createUser: vi.fn(),
      setGroupMembers: vi.fn(),
    };

    await expect(reconcileGroupMembership(authentik, "missing", [])).rejects.toThrow(/does not exist/);
  });
});
