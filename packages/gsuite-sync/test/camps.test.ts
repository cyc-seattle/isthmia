import { describe, expect, it } from "vitest";
import { isCampInMembershipWindow } from "../src/camps.js";

const now = new Date("2026-06-15T00:00:00Z");

describe("isCampInMembershipWindow", () => {
  it("is true when end_date is unset", () => {
    expect(isCampInMembershipWindow({ end_date: null }, now)).toBe(true);
  });

  it("is true when end_date is in the future", () => {
    expect(isCampInMembershipWindow({ end_date: "2026-08-01T00:00:00Z" }, now)).toBe(true);
  });

  it("is true when end_date is exactly now", () => {
    expect(isCampInMembershipWindow({ end_date: now.toISOString() }, now)).toBe(true);
  });

  it("is true when end_date is a few months in the past", () => {
    expect(isCampInMembershipWindow({ end_date: "2026-01-01T00:00:00Z" }, now)).toBe(true);
  });

  it("is false when end_date is more than ~12 months in the past", () => {
    expect(isCampInMembershipWindow({ end_date: "2025-01-01T00:00:00Z" }, now)).toBe(false);
  });
});
