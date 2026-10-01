import { describe, it, expect } from "vitest";
import { ACTIVE_CAMP } from "../src/crm/community-rules.js";

describe("ACTIVE_CAMP", () => {
  it("looks back 36 hours on end_date, covering Pacific's full last day (#166)", () => {
    expect(ACTIVE_CAMP).toEqual({
      start_date: { _lte: "$NOW" },
      end_date: { _gte: "$NOW(-36 hours)" },
    });
  });
});
