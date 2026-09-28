import { normalizeEmail } from "@cyc-seattle/crm";

export interface GroupDiff {
  toAdd: string[];
  toRemove: string[];
}

/**
 * The add/remove diff between an Authentik group's current members and the target set a pass
 * computed, both by email. Unlike `gsuite-sync`'s add-only groups, a stale member here keeps
 * portal access, so both `staff` and `families` are reconciled in full, not just grown.
 */
export function planGroupDiff(currentEmails: readonly string[], targetEmails: readonly string[]): GroupDiff {
  const current = new Set(currentEmails.map(normalizeEmail));
  const target = new Set(targetEmails.map(normalizeEmail));

  return {
    toAdd: [...target].filter((email) => !current.has(email)).sort(),
    toRemove: [...current].filter((email) => !target.has(email)).sort(),
  };
}
