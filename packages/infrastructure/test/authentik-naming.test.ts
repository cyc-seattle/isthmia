import { describe, it, expect } from "vitest";
import {
  loginHost,
  previewExternalHost,
  directusRedirectUri,
  lowercaseEmailScopeExpression,
  signInNormalizeExpression,
  signedInPolicyExpression,
  embeddedOutpostConfig,
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

describe("signInNormalizeExpression", () => {
  it("lowercases the identified email into the username, and deactivates only an unmatched placeholder", () => {
    expect(signInNormalizeExpression()).toBe(
      [
        'prompt_data = request.context["prompt_data"]',
        "email = request.user.email.lower()",
        'prompt_data["email"] = email',
        'prompt_data["username"] = email',
        "if not request.user.pk:",
        "    request.user.is_active = False",
        "return True",
      ].join("\n"),
    );
  });
});

describe("signedInPolicyExpression", () => {
  it("passes any authenticated user and messages the rest", () => {
    expect(signedInPolicyExpression()).toBe(
      [
        "if request.user.is_authenticated:",
        "    return True",
        'ak_message("We couldn\'t sign you in to this page. Use the email you registered with in Clubspot, or write to info@cyccommunitysailing.org.")',
        "return False",
      ].join("\n"),
    );
  });
});

describe("embeddedOutpostConfig", () => {
  it("points authentik_host at the login host and leaves every other key untouched", () => {
    const config = JSON.parse(embeddedOutpostConfig("cycsail.team")) as Record<string, unknown>;
    expect(config["authentik_host"]).toBe("https://login.cycsail.team");
    expect(config["kubernetes_ingress_secret_name"]).toBe("authentik-outpost-tls");
    expect(config["docker_map_ports"]).toBe(true);
  });
});

describe("STAFF_GROUP_NAME", () => {
  it("names the staff group", () => {
    expect(STAFF_GROUP_NAME).toBe("staff");
  });
});
