import { Auth, admin_directory_v1, google, groupssettings_v1 } from "googleapis";
import winston from "winston";
import { getHttpStatus, safeCall } from "./common.js";

export type GroupRole = "MEMBER" | "MANAGER" | "OWNER";

/** Ordering for `DirectoryClient.addMember`'s promotion check - never used to demote. */
const GROUP_ROLE_RANK: Record<GroupRole, number> = { MEMBER: 0, MANAGER: 1, OWNER: 2 };

export interface Group {
  id: string;
  email: string;
  name?: string;
  description?: string;
}

export interface GroupMember {
  email: string;
  role: GroupRole;
}

/**
 * Result of adding a member to a group. The sync that drives this client is
 * add-only and idempotent, so a member who's already there is an expected
 * outcome, not a failure — Google reports it as an HTTP 409.
 */
export type AddMemberResult = "added" | "already-member";

/**
 * Admin SDK Directory API client for groups and their members.
 *
 * A sub-group is added to another group the same way a user is: as a member
 * with the sub-group's email address. There's no separate method for it.
 */
export class DirectoryClient {
  private client: admin_directory_v1.Admin;

  constructor(auth: Auth.GoogleAuth) {
    // The `directory_v1` cast is needed because `google.admin` also has overloads for
    // two other API versions, which the `auth` cast below (needed for its own reasons —
    // see CalendarClient) leaves TypeScript unable to discriminate between.
    this.client = google.admin({ version: "directory_v1", auth } as any) as unknown as admin_directory_v1.Admin;
  }

  /**
   * Gets a group by email or ID. Returns null if the group doesn't exist.
   */
  async getGroup(groupKey: string): Promise<Group | null> {
    winston.debug("Getting group", { groupKey });

    try {
      // safeCall's generic argument must be given explicitly here: with `googleapis`
      // resolved through pnpm's symlinked node_modules, TypeScript can't infer it from
      // an overloaded API method passed as a callback.
      const group = await safeCall<admin_directory_v1.Schema$Group>(async () => {
        const response = await this.client.groups.get({ groupKey });
        return response.data;
      });
      return convertToGroup(group);
    } catch (error) {
      if (getHttpStatus(error) === 404) {
        winston.debug("Group not found", { groupKey });
        return null;
      }
      throw error;
    }
  }

  /**
   * Creates a new group.
   */
  async createGroup(email: string, name?: string, description?: string): Promise<Group> {
    winston.debug("Creating group", { email });

    // Built up rather than passed as a literal: under exactOptionalPropertyTypes, an
    // absent optional field and one explicitly set to undefined are different types,
    // and Schema$Group's fields are the former.
    const requestBody: admin_directory_v1.Schema$Group = { email };
    if (name) {
      requestBody.name = name;
    }
    if (description) {
      requestBody.description = description;
    }

    const group = await safeCall<admin_directory_v1.Schema$Group>(async () => {
      const response = await this.client.groups.insert({ requestBody });
      return response.data;
    });

    winston.info("Created group", { email: group.email });
    return convertToGroup(group);
  }

  /**
   * Lists all members of a group, following pagination.
   */
  async listMembers(groupKey: string): Promise<GroupMember[]> {
    winston.debug("Listing group members", { groupKey });

    const members: GroupMember[] = [];
    let pageToken: string | undefined;

    do {
      const params: admin_directory_v1.Params$Resource$Members$List = { groupKey };
      if (pageToken) {
        params.pageToken = pageToken;
      }
      const page = await safeCall<admin_directory_v1.Schema$Members>(async () => {
        const response = await this.client.members.list(params);
        return response.data;
      });
      members.push(...(page.members ?? []).map(convertToGroupMember));
      pageToken = page.nextPageToken ?? undefined;
    } while (pageToken);

    return members;
  }

  /**
   * Adds a member to a group with the given role. Returns "already-member"
   * instead of throwing when the member is already in the group (HTTP 409),
   * since the sync that calls this treats that as success - but first promotes
   * them if they're already there at a lower role than intended (e.g. added by
   * hand as a plain MEMBER). Never demotes: a member already at a higher role
   * than planned is left alone.
   */
  async addMember(groupKey: string, email: string, role: GroupRole): Promise<AddMemberResult> {
    winston.debug("Adding group member", { groupKey, email, role });

    try {
      await safeCall<admin_directory_v1.Schema$Member>(async () => {
        const response = await this.client.members.insert({ groupKey, requestBody: { email, role } });
        return response.data;
      });
      winston.info("Added group member", { groupKey, email, role });
      return "added";
    } catch (error) {
      if (getHttpStatus(error) === 409) {
        winston.debug("Member already in group", { groupKey, email });
        await this.promoteIfBelow(groupKey, email, role);
        return "already-member";
      }
      throw error;
    }
  }

  /** The 409 path of `addMember`: promotes an existing member up to `role` if they're currently
   * below it, and does nothing otherwise - including when they already outrank it. */
  private async promoteIfBelow(groupKey: string, email: string, role: GroupRole): Promise<void> {
    if (role === "MEMBER") {
      return;
    }

    const member = await safeCall<admin_directory_v1.Schema$Member>(async () => {
      const response = await this.client.members.get({ groupKey, memberKey: email });
      return response.data;
    });
    const currentRole = (member.role as GroupRole | undefined) ?? "MEMBER";

    if (GROUP_ROLE_RANK[currentRole] < GROUP_ROLE_RANK[role]) {
      await this.updateMemberRole(groupKey, email, role);
    }
  }

  /**
   * Updates an existing member's role.
   */
  async updateMemberRole(groupKey: string, email: string, role: GroupRole): Promise<void> {
    winston.debug("Updating group member role", { groupKey, email, role });

    await safeCall<admin_directory_v1.Schema$Member>(async () => {
      const response = await this.client.members.update({ groupKey, memberKey: email, requestBody: { role } });
      return response.data;
    });
    winston.info("Updated group member role", { groupKey, email, role });
  }
}

function convertToGroup(group: admin_directory_v1.Schema$Group): Group {
  const result: Group = {
    id: group.id!,
    email: group.email!,
  };

  if (group.name) {
    result.name = group.name;
  }
  if (group.description) {
    result.description = group.description;
  }

  return result;
}

function convertToGroupMember(member: admin_directory_v1.Schema$Member): GroupMember {
  return {
    email: member.email!,
    role: member.role as GroupRole,
  };
}

export type GroupSettings = groupssettings_v1.Schema$Groups;

/**
 * Groups Settings API client. Settings are a separate API from the Directory
 * API's group resource — this covers permission-level fields like who can
 * post or join, not membership.
 */
export class GroupSettingsClient {
  private client: groupssettings_v1.Groupssettings;

  constructor(auth: Auth.GoogleAuth) {
    this.client = google.groupssettings({ version: "v1", auth } as any) as groupssettings_v1.Groupssettings;
  }

  /**
   * Gets a group's settings.
   */
  async getSettings(groupEmail: string): Promise<GroupSettings> {
    winston.debug("Getting group settings", { groupEmail });

    return safeCall<GroupSettings>(async () => {
      const response = await this.client.groups.get({ groupUniqueId: groupEmail });
      return response.data;
    });
  }

  /**
   * Patches a group's settings from the given settings object.
   */
  async patchSettings(groupEmail: string, settings: GroupSettings): Promise<GroupSettings> {
    winston.debug("Patching group settings", { groupEmail });

    const result = await safeCall<GroupSettings>(async () => {
      const response = await this.client.groups.patch({ groupUniqueId: groupEmail, requestBody: settings });
      return response.data;
    });

    winston.info("Patched group settings", { groupEmail });
    return result;
  }
}
