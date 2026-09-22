import { describe, expect, it } from "vitest";
import { planGroupNesting } from "../src/nesting.js";
import { GoogleGroupRow } from "../src/schema.js";

function group(overrides: Partial<GoogleGroupRow>): GoogleGroupRow {
  return {
    id: "group",
    email: "group@cyccommunitysailing.org",
    name: null,
    settings_template: null,
    parent_id: null,
    ...overrides,
  };
}

describe("planGroupNesting", () => {
  it("resolves a class group to its program group as parent", () => {
    const program = group({ id: "program-1", email: "program@cyccommunitysailing.org" });
    const cls = group({ id: "class-1", email: "class@cyccommunitysailing.org", parent_id: "program-1" });

    const result = planGroupNesting([program, cls]);

    expect(result).toEqual([{ child: cls, parent: program }]);
  });

  it("excludes a row with no parent_id", () => {
    const result = planGroupNesting([group({ id: "program-1", parent_id: null })]);

    expect(result).toEqual([]);
  });

  it("excludes a row whose parent_id doesn't resolve to another row", () => {
    const result = planGroupNesting([group({ id: "class-1", parent_id: "missing" })]);

    expect(result).toEqual([]);
  });
});
