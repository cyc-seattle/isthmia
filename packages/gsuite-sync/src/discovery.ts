import { Group, GroupMember } from "@cyc-seattle/gsuite";
import { GoogleGroupRow } from "./schema.js";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface GroupDiscoveryPlan {
  toCreate: Omit<GoogleGroupRow, "id">[];
  /** `name` only - never `settings_template` or `parent_id`, which are staff-set or set by
   * `planGroupNestingDiscovery` below, not by this reconcile. */
  toUpdate: { id: string; patch: Partial<GoogleGroupRow> }[];
}

/**
 * Reconciles `google_groups` by `email` against every group Workspace actually has. A live group
 * with no matching row becomes a new one, created with no `settings_template` or `parent_id` -
 * both are set later, by a human and by `planGroupNestingDiscovery` respectively. An existing
 * row's `name` is refreshed if it drifted; nothing else about it is touched.
 *
 * A `google_groups` row whose email no longer appears in `liveGroups` is left alone: deleting it
 * would silently break whatever class or program points at it, and the audit pass's
 * `findMissingGroup` already reports the row as stale on Workspace's own say-so.
 */
export function planGroupUpserts(
  liveGroups: readonly Group[],
  existing: readonly GoogleGroupRow[],
): GroupDiscoveryPlan {
  const existingByEmail = new Map(existing.map((row) => [normalizeEmail(row.email), row] as const));

  const toCreate: Omit<GoogleGroupRow, "id">[] = [];
  const toUpdate: { id: string; patch: Partial<GoogleGroupRow> }[] = [];

  for (const group of liveGroups) {
    const name = group.name ?? null;
    const match = existingByEmail.get(normalizeEmail(group.email));

    if (!match?.id) {
      toCreate.push({ email: group.email, name, settings_template: null, parent_id: null });
      continue;
    }
    if (match.name !== name) {
      toUpdate.push({ id: match.id, patch: { name } });
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
