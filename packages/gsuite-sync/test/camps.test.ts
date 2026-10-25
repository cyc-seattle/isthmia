import { describe, expect, it } from "vitest";
import { isCampActive } from "../src/camps.js";

const now = new Date("2026-06-15T00:00:00Z");

describe("isCampActive", () => {
  it("is true when end_date is unset", () => {
    expect(isCampActive({ end_date: null, archived: false }, now)).toBe(true);
  });

  it("is true when end_date is in the future", () => {
    expect(isCampActive({ end_date: "2026-08-01", archived: false }, now)).toBe(true);
  });

  it("is true when end_date is today in Seattle", () => {
    expect(isCampActive({ end_date: "2026-06-14", archived: false }, now)).toBe(true);
  });

  it("is true late in the Pacific evening of end_date, after UTC midnight", () => {
    expect(isCampActive({ end_date: "2026-06-14", archived: false }, new Date("2026-06-15T05:00:00Z"))).toBe(true);
  });

  it("is false when end_date was yesterday in Seattle", () => {
    expect(isCampActive({ end_date: "2026-06-13", archived: false }, now)).toBe(false);
  });

  it("is false when the camp is archived, even if it hasn't ended", () => {
    expect(isCampActive({ end_date: "2026-08-01", archived: true }, now)).toBe(false);
  });

  it("is false when the camp is archived with no end_date", () => {
    expect(isCampActive({ end_date: null, archived: true }, now)).toBe(false);
  });
});
