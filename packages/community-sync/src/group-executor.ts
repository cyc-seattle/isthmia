import { normalizeEmail } from "@cyc-seattle/crm";
import { AuthentikClient } from "./authentik.js";
import { planGroupDiff } from "./group-diff.js";

export interface ReconcileGroupResult {
  added: number;
  removed: number;
  usersCreated: number;
}

/**
 * Reconciles one Authentik group's membership to exactly `targetEmails`: creates any missing user
 * first, keyed on the lowercased email, then replaces the group's member list in one call - which
 * is what makes this an add-**and**-remove reconcile rather than the add-only shape `gsuite-sync`
 * uses for Google Groups (a stale member there merely stops being re-added; here it would keep
 * portal access).
 */
export async function reconcileGroupMembership(
  authentik: AuthentikClient,
  groupName: string,
  targetEmails: readonly string[],
): Promise<ReconcileGroupResult> {
  const group = await authentik.getGroup(groupName);
  if (!group) {
    throw new Error(`Authentik group "${groupName}" does not exist; it must be created before this job can run`);
  }

  const currentEmails = group.members.map((member) => member.email);
  const { toAdd, toRemove } = planGroupDiff(currentEmails, targetEmails);

  const pkByEmail = new Map(group.members.map((member) => [normalizeEmail(member.email), member.pk]));
  let usersCreated = 0;
  for (const email of toAdd) {
    let user = await authentik.findUserByEmail(email);
    if (!user) {
      user = await authentik.createUser(email);
      usersCreated++;
    }
    pkByEmail.set(email, user.pk);
  }
  for (const email of toRemove) {
    pkByEmail.delete(normalizeEmail(email));
  }

  if (toAdd.length > 0 || toRemove.length > 0) {
    await authentik.setGroupMembers(group.pk, [...pkByEmail.values()]);
  }

  return { added: toAdd.length, removed: toRemove.length, usersCreated };
}
