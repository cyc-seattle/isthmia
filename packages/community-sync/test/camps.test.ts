import { describe, expect, it } from "vitest";
import { isCampActive } from "../src/camps.js";

const now = new Date("2026-07-15T00:00:00Z");

describe("isCampActive", () => {
  it("is active when now falls within start and end", () => {
    expect(isCampActive({ start_date: "2026-07-01", end_date: "2026-07-31" }, now)).toBe(true);
  });

  it("is not active once the camp has ended", () => {
    expect(isCampActive({ start_date: "2026-01-01", end_date: "2026-01-31" }, now)).toBe(false);
  });

  it("is not active before the camp starts", () => {
    expect(isCampActive({ start_date: "2026-08-01", end_date: "2026-08-31" }, now)).toBe(false);
  });

  it("is not active with a null start_date", () => {
    expect(isCampActive({ start_date: null, end_date: "2026-08-31" }, now)).toBe(false);
  });

  it("is not active with a null end_date", () => {
    expect(isCampActive({ start_date: "2026-01-01", end_date: null }, now)).toBe(false);
  });
});
