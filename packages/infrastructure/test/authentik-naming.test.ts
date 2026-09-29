import { describe, it, expect } from "vitest";
import {
  loginHost,
  previewExternalHost,
  directusRedirectUri,
  lowercaseEmailScopeExpression,
  enrollmentNormalizeExpression,
  STAFF_GROUP_NAME,
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

describe("enrollmentNormalizeExpression", () => {
  it("lowercases the submitted email and reuses it as the username", () => {
    expect(enrollmentNormalizeExpression()).toBe(
      [
        'prompt_data = request.context["prompt_data"]',
        'prompt_data["email"] = prompt_data["email"].lower()',
        'prompt_data["username"] = prompt_data["email"]',
        "return True",
      ].join("\n"),
    );
  });
});

describe("STAFF_GROUP_NAME", () => {
  it("names the staff group", () => {
    expect(STAFF_GROUP_NAME).toBe("staff");
  });
});
