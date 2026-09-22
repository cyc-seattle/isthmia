import { describe, expect, it } from "vitest";
import { GoogleGroupRow } from "../src/schema.js";
import { planGroupsWithSettings } from "../src/settings.js";

function group(overrides: Partial<GoogleGroupRow>): GoogleGroupRow {
  return {
    id: "group-1",
    email: "group-1@cyccommunitysailing.org",
    name: null,
    settings_template: null,
    parent_id: null,
    ...overrides,
  };
}

describe("planGroupsWithSettings", () => {
  it("includes a row with a settings_template set", () => {
    const template = { whoCanJoin: "INVITED_CAN_JOIN" };
    const result = planGroupsWithSettings([group({ settings_template: template })]);

    expect(result).toEqual([group({ settings_template: template })]);
  });

  it("excludes a row with no settings_template", () => {
    const result = planGroupsWithSettings([group({ settings_template: null })]);

    expect(result).toEqual([]);
  });
});
