import { describe, expect, it } from "vitest";
import { isCampActive } from "../src/camps.js";

const now = new Date("2026-06-15T00:00:00Z");

describe("isCampActive", () => {
  it("is true when end_date is unset", () => {
    expect(isCampActive({ end_date: null, archived: false }, now)).toBe(true);
  });

  it("is true when end_date is in the future", () => {
    expect(isCampActive({ end_date: "2026-08-01T00:00:00Z", archived: false }, now)).toBe(true);
  });

  it("is true when end_date is exactly now", () => {
    expect(isCampActive({ end_date: now.toISOString(), archived: false }, now)).toBe(true);
  });

  it("is false when end_date has passed", () => {
    expect(isCampActive({ end_date: "2026-06-14T00:00:00Z", archived: false }, now)).toBe(false);
  });

  it("is false when the camp is archived, even if it hasn't ended", () => {
    expect(isCampActive({ end_date: "2026-08-01T00:00:00Z", archived: true }, now)).toBe(false);
  });

  it("is false when the camp is archived with no end_date", () => {
    expect(isCampActive({ end_date: null, archived: true }, now)).toBe(false);
  });
});
