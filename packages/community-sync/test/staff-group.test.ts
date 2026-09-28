import { describe, expect, it } from "vitest";
import { GroupMember } from "@cyc-seattle/gsuite";
import { planStaffGroupEmails } from "../src/staff-group.js";

describe("planStaffGroupEmails", () => {
  it("normalizes and dedupes member emails", () => {
    const members: GroupMember[] = [
      { email: " A@Example.com ", role: "MEMBER" },
      { email: "a@example.com", role: "OWNER" },
    ];

    const { emails, skipped } = planStaffGroupEmails(members);

    expect(emails).toEqual(["a@example.com"]);
    expect(skipped).toBe(0);
  });

  it("excludes a nested sub-group's own entry", () => {
    const members: GroupMember[] = [
      { email: "sub@cyccommunitysailing.org", role: "MEMBER", type: "GROUP" },
      { email: "person@example.com", role: "MEMBER", type: "USER" },
    ];

    const { emails } = planStaffGroupEmails(members);

    expect(emails).toEqual(["person@example.com"]);
  });

  it("skips and counts a member with an unusable email", () => {
    const members: GroupMember[] = [{ email: "not-an-email", role: "MEMBER" }];

    const { emails, skipped } = planStaffGroupEmails(members);

    expect(emails).toEqual([]);
    expect(skipped).toBe(1);
  });
});
