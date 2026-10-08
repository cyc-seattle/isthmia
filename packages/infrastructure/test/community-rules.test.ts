import { describe, it, expect } from "vitest";
import { ACTIVE_CAMP, communityPolicies } from "../src/crm/community-rules.js";

describe("ACTIVE_CAMP", () => {
  it("looks back 36 hours on end_date, covering Pacific's full last day (#166)", () => {
    expect(ACTIVE_CAMP).toEqual({
      start_date: { _lte: "$NOW" },
      end_date: { _gte: "$NOW(-36 hours)" },
    });
  });
});

describe("family policy's own-guardian-link grant", () => {
  it("reads only subject_id, contact_id, and relationship_type on contacts (#166)", () => {
    const family = communityPolicies.find((policy) => policy.key === "family")!;
    const rule = family.rules.find((r) => r.collection === "contacts")!;
    expect(rule.action).toBe("read");
    expect(rule.fields.sort()).toEqual(["contact_id", "relationship_type", "subject_id"]);
  });
});
