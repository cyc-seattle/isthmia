import { Group, GroupMember } from "@cyc-seattle/gsuite";
import { GoogleGroupRow } from "./schema.js";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface GroupDiscoveryPlan {
  toCreate: Omit<GoogleGroupRow, "id">[];
  /** `name`, `description`, and `archived` only - never `settings_template` or `parent_id`, which
   * are staff-set or set by `planGroupNestingDiscovery` below, not by this reconcile. */
  toUpdate: { id: string; patch: Partial<GoogleGroupRow> }[];
}

/**
 * Reconciles `google_groups` by `email` against every group Workspace actually has. A live group
 * with no matching row becomes a new one, created unarchived with no `settings_template` or
 * `parent_id` - both are set later, by a human and by `planGroupNestingDiscovery` respectively. An
 * existing row's `name` and `description` are refreshed if they drifted.
 *
 * A row whose email no longer appears in `liveGroups` is archived rather than deleted: deleting it
 * would silently break whatever class or program points at it. A row that reappears is
 * unarchived as-is, keeping its `settings_template` and `parent_id` rather than resetting them.
 *
 * `liveGroups` empty throws instead of archiving every row - that shape means the Workspace
 * listing failed, not that the domain has no groups.
 */
export function planGroupUpserts(
  liveGroups: readonly Group[],
  existing: readonly GoogleGroupRow[],
): GroupDiscoveryPlan {
  if (liveGroups.length === 0) {
    throw new Error("planGroupUpserts: live Workspace group list is empty; refusing to archive every row");
  }

  const existingByEmail = new Map(existing.map((row) => [normalizeEmail(row.email), row] as const));
  const liveEmails = new Set(liveGroups.map((group) => normalizeEmail(group.email)));

  const toCreate: Omit<GoogleGroupRow, "id">[] = [];
  const toUpdate: { id: string; patch: Partial<GoogleGroupRow> }[] = [];

  for (const group of liveGroups) {
    const name = group.name ?? null;
    const description = group.description ?? null;
    const match = existingByEmail.get(normalizeEmail(group.email));

    if (!match?.id) {
      toCreate.push({
        email: group.email,
        name,
        description,
        settings_template: null,
        parent_id: null,
        archived: false,
      });
      continue;
    }

    const patch: Partial<GoogleGroupRow> = {};
    if (match.name !== name) {
      patch.name = name;
    }
    if (match.description !== description) {
      patch.description = description;
    }
    if (match.archived) {
      patch.archived = false;
    }
    if (Object.keys(patch).length > 0) {
      toUpdate.push({ id: match.id, patch });
    }
  }

  for (const row of existing) {
    if (row.id && !row.archived && !liveEmails.has(normalizeEmail(row.email))) {
      toUpdate.push({ id: row.id, patch: { archived: true } });
    }
  }

  return { toCreate, toUpdate };
}

/**
 * Derives `parent_id` from live Workspace membership: a `GROUP`-typed member of `parent`'s live
 * membership makes `parent` the discovered parent of that child group. `membersByEmail` is keyed
 * on each group's own `email` field, exactly as stored on `groups` - the caller fetches it with
 * `DirectoryClient.listMembers(group.email)` for every row.
 *
 * Only ever sets `parent_id` when live membership resolves one. A group with no discovered parent
 * keeps whatever `parent_id` is already stored: that may be a hand-set value the nesting pass
 * hasn't applied to Workspace yet, and clobbering it here would make that hand-set nesting
 * unrecoverable. If a child is a live member of more than one group, the first one found wins,
 * matching `parent_id`'s single-parent shape.
 */
export function planGroupNestingDiscovery(
  groups: readonly GoogleGroupRow[],
  membersByEmail: ReadonlyMap<string, readonly GroupMember[]>,
): { id: string; patch: Partial<GoogleGroupRow> }[] {
  const rowByEmail = new Map(groups.filter((row) => row.id).map((row) => [normalizeEmail(row.email), row] as const));

  const parentIdByChildId = new Map<string, string>();
  for (const parent of groups) {
    if (!parent.id) {
      continue;
    }
    for (const member of membersByEmail.get(parent.email) ?? []) {
      if (member.type !== "GROUP") {
        continue;
      }
      const child = rowByEmail.get(normalizeEmail(member.email));
      if (child?.id && !parentIdByChildId.has(child.id)) {
        parentIdByChildId.set(child.id, parent.id);
      }
    }
  }

  const rowById = new Map(groups.filter((row) => row.id).map((row) => [row.id as string, row] as const));
  const patches: { id: string; patch: Partial<GoogleGroupRow> }[] = [];
  for (const [childId, parentId] of parentIdByChildId) {
    if (rowById.get(childId)?.parent_id !== parentId) {
      patches.push({ id: childId, patch: { parent_id: parentId } });
    }
  }
  return patches;
}
