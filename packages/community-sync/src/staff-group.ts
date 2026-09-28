import winston from "winston";
import { isValidEmail, normalizeEmail } from "@cyc-seattle/crm";
import { GroupMember } from "@cyc-seattle/gsuite";

export interface StaffGroupPlan {
  emails: string[];
  /** A member Google reports whose address `isValidEmail` rejects - counted rather than added, so
   * a typo'd or non-email member doesn't silently fail Authentik user creation. */
  skipped: number;
}

/**
 * Every real person in `all@`'s membership - `listMembers(..., { includeDerivedMembership: true })`
 * already flattens nested groups into their member users, so a `type: "GROUP"` entry here is the
 * sub-group itself, not a person, and is excluded rather than added as its own Authentik user.
 */
export function planStaffGroupEmails(members: readonly GroupMember[]): StaffGroupPlan {
  const emails = new Set<string>();
  let skipped = 0;

  for (const member of members) {
    if (member.type === "GROUP") {
      continue;
    }
    if (!isValidEmail(member.email)) {
      skipped++;
      continue;
    }
    emails.add(normalizeEmail(member.email));
  }

  if (skipped > 0) {
    winston.warn(`Skipped ${skipped} all@ member(s) with an unusable email`, { skipped });
  }

  return { emails: [...emails].sort(), skipped };
}
