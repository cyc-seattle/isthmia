import { normalizeEmail } from "@cyc-seattle/crm";

export interface GroupDiff {
  toAdd: string[];
  toRemove: string[];
}

export interface PlanGroupDiffOptions {
  /** Overrides the safety guard below - set from the CLI's `--allow-large-removal`. */
  allowLargeRemoval?: boolean;
}

/**
 * Refuses a diff that would empty a group with current members, or remove more than half of
 * them, unless `allowLargeRemoval` is set. A wrong or collapsed source read (an empty Google
 * Groups page, a Directus query gone wrong) looks exactly like "remove everyone" to `planGroupDiff`
 * otherwise, and `reconcileGroupMembership` would lock every remaining member out on the next run.
 */
function assertSafeRemoval(currentCount: number, targetCount: number, removedCount: number): void {
  if (targetCount === 0 && currentCount > 0) {
    throw new Error(
      `planGroupDiff: planned membership is empty but the group currently has ${currentCount} member(s); ` +
        "refusing to remove them all. Pass --allow-large-removal to override.",
    );
  }
  if (removedCount > currentCount / 2) {
    throw new Error(
      `planGroupDiff: this plan would remove ${removedCount} of ${currentCount} current member(s), more than ` +
        "half; refusing to apply. Pass --allow-large-removal to override.",
    );
  }
}

/**
 * The add/remove diff between an Authentik group's current members and the target set a pass
 * computed, both by email. Unlike `gsuite-sync`'s add-only groups, a stale member here keeps
 * portal access, so both `staff` and `families` are reconciled in full, not just grown.
 */
export function planGroupDiff(
  currentEmails: readonly string[],
  targetEmails: readonly string[],
  options: PlanGroupDiffOptions = {},
): GroupDiff {
  const current = new Set(currentEmails.map(normalizeEmail));
  const target = new Set(targetEmails.map(normalizeEmail));

  const toAdd = [...target].filter((email) => !current.has(email)).sort();
  const toRemove = [...current].filter((email) => !target.has(email)).sort();

  if (!options.allowLargeRemoval) {
    assertSafeRemoval(current.size, target.size, toRemove.length);
  }

  return { toAdd, toRemove };
}
