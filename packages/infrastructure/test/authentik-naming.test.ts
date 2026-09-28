import { describe, it, expect } from "vitest";
import {
  loginHost,
  previewExternalHost,
  directusRedirectUri,
  lowercaseEmailScopeExpression,
  communitySyncPermissions,
  STAFF_GROUP_NAME,
  FAMILIES_GROUP_NAME,
} from "../src/authentik/naming.js";

describe("hostnames", () => {
  it("builds the Authentik login host with no scheme", () => {
    expect(loginHost("cycsail.team")).toBe("login.cycsail.team");
  });

  it("builds the preview external host as a URL", () => {
    expect(previewExternalHost("cycsail.team")).toBe("https://preview.cycsail.team");
  });

  it("builds Directus's OIDC callback URL", () => {
    expect(directusRedirectUri("cycsail.team")).toBe("https://directus.cycsail.team/auth/login/authentik/callback");
  });
});

describe("lowercaseEmailScopeExpression", () => {
  it("lowercases the user's email in the returned claim", () => {
    expect(lowercaseEmailScopeExpression()).toBe('return {"email": request.user.email.lower()}');
  });
});

describe("communitySyncPermissions", () => {
  it("grants create-user globally and change-group scoped to each group only", () => {
    expect(communitySyncPermissions("staff-uuid", "families-uuid")).toEqual([
      { permission: "authentik_core.add_user" },
      { model: "authentik_core.group", permission: "authentik_core.change_group", objectId: "staff-uuid" },
      { model: "authentik_core.group", permission: "authentik_core.change_group", objectId: "families-uuid" },
    ]);
  });

  it("names the two groups community-sync manages", () => {
    expect(STAFF_GROUP_NAME).toBe("staff");
    expect(FAMILIES_GROUP_NAME).toBe("families");
  });
});
