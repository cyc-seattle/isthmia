import { describe, expect, it } from "vitest";
import { GoogleGroupRow } from "../src/schema.js";
import { planGroupsWithSettings } from "../src/settings.js";

function group(overrides: Partial<GoogleGroupRow>): GoogleGroupRow {
  return {
    id: "group-1",
    email: "group-1@cyccommunitysailing.org",
    name: null,
    description: null,
    settings_template: null,
    parent_id: null,
    archived: false,
    ...overrides,
  };
}

describe("planGroupsWithSettings", () => {
  it("includes a row with a settings_template set", () => {
    const result = planGroupsWithSettings([group({ settings_template: "participants" })]);

    expect(result).toEqual([group({ settings_template: "participants" })]);
  });

  it("excludes a row with no settings_template", () => {
    const result = planGroupsWithSettings([group({ settings_template: null })]);

    expect(result).toEqual([]);
  });

  it("excludes an archived row even with a settings_template set", () => {
    const result = planGroupsWithSettings([group({ settings_template: "participants", archived: true })]);

    expect(result).toEqual([]);
  });
});
