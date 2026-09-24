import { describe, expect, it } from "vitest";
import {
  GROUP_SETTINGS_TEMPLATE_NAMES,
  GroupSettingsTemplateName,
  resolveGroupSettingsTemplate,
} from "../src/group-settings-templates.js";

describe("resolveGroupSettingsTemplate", () => {
  it.each(GROUP_SETTINGS_TEMPLATE_NAMES)("resolves the %s template", (name: GroupSettingsTemplateName) => {
    const settings = resolveGroupSettingsTemplate(name);

    expect(settings.whoCanJoin).toBe("INVITED_CAN_JOIN");
  });

  it("carries allowExternalMembers on participants, so guardians on personal Gmail get mail", () => {
    expect(resolveGroupSettingsTemplate("participants").allowExternalMembers).toBe("true");
  });

  it("throws on an unrecognized name instead of returning nothing", () => {
    expect(() => resolveGroupSettingsTemplate("bogus")).toThrow(/Unknown Google Group settings template "bogus"/);
  });
});
