import { describe, expect, it } from "vitest";
import { isCurrentOrFutureOffering } from "../src/offerings.js";

const now = new Date("2026-06-15T00:00:00Z");

describe("isCurrentOrFutureOffering", () => {
  it("is true when end_date is unset", () => {
    expect(isCurrentOrFutureOffering({ end_date: null }, now)).toBe(true);
  });

  it("is true when end_date is in the future", () => {
    expect(isCurrentOrFutureOffering({ end_date: "2026-08-01T00:00:00Z" }, now)).toBe(true);
  });

  it("is true when end_date is exactly now", () => {
    expect(isCurrentOrFutureOffering({ end_date: now.toISOString() }, now)).toBe(true);
  });

  it("is false when end_date is in the past", () => {
    expect(isCurrentOrFutureOffering({ end_date: "2026-01-01T00:00:00Z" }, now)).toBe(false);
  });
});
