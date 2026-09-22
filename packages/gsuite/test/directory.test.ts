import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Auth } from "googleapis";

const {
  adminMock,
  groupssettingsMock,
  groupsGet,
  groupsInsert,
  membersList,
  membersInsert,
  membersUpdate,
  membersGet,
  settingsGet,
  settingsPatch,
} = vi.hoisted(() => ({
  adminMock: vi.fn(),
  groupssettingsMock: vi.fn(),
  groupsGet: vi.fn(),
  groupsInsert: vi.fn(),
  membersList: vi.fn(),
  membersInsert: vi.fn(),
  membersUpdate: vi.fn(),
  membersGet: vi.fn(),
  settingsGet: vi.fn(),
  settingsPatch: vi.fn(),
}));

vi.mock("googleapis", () => ({
  google: {
    admin: adminMock,
    groupssettings: groupssettingsMock,
  },
}));

const { DirectoryClient, GroupSettingsClient } = await import("../src/directory.js");

const fakeAuth = {} as Auth.GoogleAuth;

// googleapis (gaxios) reports the HTTP status as a numeric `code`.
function gaxiosError(code: number) {
  return { code, message: `gaxios error ${code}` };
}

beforeEach(() => {
  vi.useFakeTimers();
  adminMock.mockReturnValue({
    groups: { get: groupsGet, insert: groupsInsert },
    members: { list: membersList, insert: membersInsert, update: membersUpdate, get: membersGet },
  });
  groupssettingsMock.mockReturnValue({
    groups: { get: settingsGet, patch: settingsPatch },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function run<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

describe("DirectoryClient.getGroup", () => {
  it("returns a Group for an existing group", async () => {
    groupsGet.mockResolvedValue({
      data: { id: "123", email: "sailors@cyccommunitysailing.org", name: "Sailors" },
    });
    const client = new DirectoryClient(fakeAuth);

    const group = await run(client.getGroup("sailors@cyccommunitysailing.org"));

    expect(group).toEqual({ id: "123", email: "sailors@cyccommunitysailing.org", name: "Sailors" });
    expect(groupsGet).toHaveBeenCalledWith({ groupKey: "sailors@cyccommunitysailing.org" });
  });

  it("omits name and description when the group lacks them", async () => {
    groupsGet.mockResolvedValue({ data: { id: "123", email: "sailors@cyccommunitysailing.org" } });
    const client = new DirectoryClient(fakeAuth);

    const group = await run(client.getGroup("sailors@cyccommunitysailing.org"));

    expect(group).not.toHaveProperty("name");
    expect(group).not.toHaveProperty("description");
  });

  it("returns null when the group doesn't exist", async () => {
    groupsGet.mockRejectedValue(gaxiosError(404));
    const client = new DirectoryClient(fakeAuth);

    const group = await run(client.getGroup("missing@cyccommunitysailing.org"));

    expect(group).toBeNull();
  });

  it("rethrows any other error", async () => {
    groupsGet.mockRejectedValue(gaxiosError(400));
    const client = new DirectoryClient(fakeAuth);

    await expect(run(client.getGroup("sailors@cyccommunitysailing.org"))).rejects.toEqual(gaxiosError(400));
  });
});

describe("DirectoryClient.createGroup", () => {
  it("creates a group and returns it", async () => {
    groupsInsert.mockResolvedValue({
      data: { id: "456", email: "guardians@cyccommunitysailing.org", description: "Guardians" },
    });
    const client = new DirectoryClient(fakeAuth);

    const group = await run(client.createGroup("guardians@cyccommunitysailing.org", undefined, "Guardians"));

    expect(groupsInsert).toHaveBeenCalledWith({
      requestBody: {
        email: "guardians@cyccommunitysailing.org",
        name: undefined,
        description: "Guardians",
      },
    });
    expect(group).toEqual({
      id: "456",
      email: "guardians@cyccommunitysailing.org",
      description: "Guardians",
    });
  });
});

describe("DirectoryClient.listMembers", () => {
  it("follows pagination and flattens the results", async () => {
    membersList
      .mockResolvedValueOnce({
        data: {
          members: [{ email: "a@example.com", role: "MEMBER" }],
          nextPageToken: "page-2",
        },
      })
      .mockResolvedValueOnce({
        data: { members: [{ email: "b@example.com", role: "OWNER" }] },
      });
    const client = new DirectoryClient(fakeAuth);

    const members = await run(client.listMembers("sailors@cyccommunitysailing.org"));

    expect(members).toEqual([
      { email: "a@example.com", role: "MEMBER" },
      { email: "b@example.com", role: "OWNER" },
    ]);
    expect(membersList).toHaveBeenNthCalledWith(1, {
      groupKey: "sailors@cyccommunitysailing.org",
      pageToken: undefined,
    });
    expect(membersList).toHaveBeenNthCalledWith(2, {
      groupKey: "sailors@cyccommunitysailing.org",
      pageToken: "page-2",
    });
  });

  it("returns an empty array for a group with no members", async () => {
    membersList.mockResolvedValue({ data: {} });
    const client = new DirectoryClient(fakeAuth);

    const members = await run(client.listMembers("empty@cyccommunitysailing.org"));

    expect(members).toEqual([]);
  });
});

describe("DirectoryClient.addMember", () => {
  it("adds a member with the given role", async () => {
    membersInsert.mockResolvedValue({ data: { email: "guardian@example.com", role: "MEMBER" } });
    const client = new DirectoryClient(fakeAuth);

    const result = await run(client.addMember("guardians@cyccommunitysailing.org", "guardian@example.com", "MEMBER"));

    expect(result).toBe("added");
    expect(membersInsert).toHaveBeenCalledWith({
      groupKey: "guardians@cyccommunitysailing.org",
      requestBody: { email: "guardian@example.com", role: "MEMBER" },
    });
  });

  it("accepts an external, non-Workspace member address", async () => {
    membersInsert.mockResolvedValue({ data: { email: "parent@gmail.com", role: "MEMBER" } });
    const client = new DirectoryClient(fakeAuth);

    const result = await run(client.addMember("guardians@cyccommunitysailing.org", "parent@gmail.com", "MEMBER"));

    expect(result).toBe("added");
  });

  it("reports an already-existing member as 'already-member' instead of throwing", async () => {
    membersInsert.mockRejectedValue(gaxiosError(409));
    const client = new DirectoryClient(fakeAuth);

    const result = await run(client.addMember("guardians@cyccommunitysailing.org", "guardian@example.com", "MEMBER"));

    expect(result).toBe("already-member");
    expect(membersGet).not.toHaveBeenCalled();
  });

  it("promotes an already-existing member who holds a lower role than intended", async () => {
    membersInsert.mockRejectedValue(gaxiosError(409));
    membersGet.mockResolvedValue({ data: { email: "guardian@example.com", role: "MEMBER" } });
    membersUpdate.mockResolvedValue({ data: { email: "guardian@example.com", role: "MANAGER" } });
    const client = new DirectoryClient(fakeAuth);

    const result = await run(client.addMember("guardians@cyccommunitysailing.org", "guardian@example.com", "MANAGER"));

    expect(result).toBe("already-member");
    expect(membersUpdate).toHaveBeenCalledWith({
      groupKey: "guardians@cyccommunitysailing.org",
      memberKey: "guardian@example.com",
      requestBody: { role: "MANAGER" },
    });
  });

  it("never demotes an already-existing member who already outranks the intended role", async () => {
    membersInsert.mockRejectedValue(gaxiosError(409));
    membersGet.mockResolvedValue({ data: { email: "owner@example.com", role: "OWNER" } });
    membersUpdate.mockClear();
    const client = new DirectoryClient(fakeAuth);

    const result = await run(client.addMember("guardians@cyccommunitysailing.org", "owner@example.com", "MANAGER"));

    expect(result).toBe("already-member");
    expect(membersUpdate).not.toHaveBeenCalled();
  });

  it("rethrows a non-409 failure", async () => {
    membersInsert.mockRejectedValue(gaxiosError(403));
    const client = new DirectoryClient(fakeAuth);

    await expect(
      run(client.addMember("guardians@cyccommunitysailing.org", "guardian@example.com", "MEMBER")),
    ).rejects.toEqual(gaxiosError(403));
  });

  it("adds a sub-group as a member via the same members endpoint", async () => {
    membersInsert.mockResolvedValue({
      data: { email: "coaches@cyccommunitysailing.org", role: "MEMBER" },
    });
    const client = new DirectoryClient(fakeAuth);

    await run(client.addMember("staff@cyccommunitysailing.org", "coaches@cyccommunitysailing.org", "MEMBER"));

    expect(membersInsert).toHaveBeenCalledWith({
      groupKey: "staff@cyccommunitysailing.org",
      requestBody: { email: "coaches@cyccommunitysailing.org", role: "MEMBER" },
    });
  });
});

describe("DirectoryClient.updateMemberRole", () => {
  it("updates an existing member's role", async () => {
    membersUpdate.mockResolvedValue({ data: { email: "guardian@example.com", role: "MANAGER" } });
    const client = new DirectoryClient(fakeAuth);

    await run(client.updateMemberRole("guardians@cyccommunitysailing.org", "guardian@example.com", "MANAGER"));

    expect(membersUpdate).toHaveBeenCalledWith({
      groupKey: "guardians@cyccommunitysailing.org",
      memberKey: "guardian@example.com",
      requestBody: { role: "MANAGER" },
    });
  });
});

describe("GroupSettingsClient", () => {
  it("getSettings returns the group's settings", async () => {
    settingsGet.mockResolvedValue({ data: { whoCanJoin: "INVITED_CAN_JOIN" } });
    const client = new GroupSettingsClient(fakeAuth);

    const settings = await run(client.getSettings("sailors@cyccommunitysailing.org"));

    expect(settings).toEqual({ whoCanJoin: "INVITED_CAN_JOIN" });
    expect(settingsGet).toHaveBeenCalledWith({ groupUniqueId: "sailors@cyccommunitysailing.org" });
  });

  it("patchSettings sends the given settings and returns the result", async () => {
    settingsPatch.mockResolvedValue({ data: { whoCanJoin: "ALL_IN_DOMAIN_CAN_JOIN" } });
    const client = new GroupSettingsClient(fakeAuth);

    const settings = await run(
      client.patchSettings("sailors@cyccommunitysailing.org", { whoCanJoin: "ALL_IN_DOMAIN_CAN_JOIN" }),
    );

    expect(settingsPatch).toHaveBeenCalledWith({
      groupUniqueId: "sailors@cyccommunitysailing.org",
      requestBody: { whoCanJoin: "ALL_IN_DOMAIN_CAN_JOIN" },
    });
    expect(settings).toEqual({ whoCanJoin: "ALL_IN_DOMAIN_CAN_JOIN" });
  });
});
