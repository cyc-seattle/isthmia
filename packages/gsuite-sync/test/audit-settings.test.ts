import { describe, expect, it } from "vitest";
import { resolveGroupSettingsTemplate } from "@cyc-seattle/gsuite";
import { findSettingsDrift } from "../src/audit-settings.js";

function resolveInboxWithout(field: string): Record<string, unknown> {
  const settings = { ...(resolveGroupSettingsTemplate("inbox") as Record<string, unknown>) };
  delete settings[field];
  return settings;
}

describe("findSettingsDrift", () => {
  it("names each drifted field with its live and template values", () => {
    const result = findSettingsDrift(
      { email: "j-pod@cyccommunitysailing.org", settings_template: "participants" },
      { whoCanJoin: "ANYONE_CAN_JOIN" },
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.detail).toContain('whoCanJoin (live "ANYONE_CAN_JOIN", template "INVITED_CAN_JOIN")');
    expect(result[0]?.detail).toContain('allowWebPosting (live undefined, template "true")');
  });

  it("ignores default_sender, which the API never returns on read", () => {
    const result = findSettingsDrift(
      { email: "info@cyccommunitysailing.org", settings_template: "inbox" },
      resolveInboxWithout("default_sender"),
    );

    expect(result).toEqual([]);
  });
});
