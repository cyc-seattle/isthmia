import { describe, it, expect } from "vitest";
import {
  loginHost,
  directusRedirectUri,
  lowercaseEmailScopeExpression,
  signInNormalizeExpression,
  pendingVerificationDenialExpression,
  clearPendingVerificationExpression,
  signedInPolicyExpression,
  embeddedOutpostConfig,
  STAFF_GROUP_NAME,
  PENDING_EMAIL_VERIFICATION_ATTRIBUTE,
} from "../src/authentik/naming.js";

describe("hostnames", () => {
  it("builds the Authentik login host with no scheme", () => {
    expect(loginHost("cycsail.team")).toBe("login.cycsail.team");
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
  it("writes username, email, and the pending-verification attribute only for an unmatched placeholder", () => {
    expect(signInNormalizeExpression()).toBe(
      [
        "if not request.user.pk:",
        '    context["flow_plan"].context.pop("pending_user", None)',
        "    email = request.user.email.lower()",
        `    context["flow_plan"].context["prompt_data"] = {"username": email, "email": email, "attributes.${PENDING_EMAIL_VERIFICATION_ATTRIBUTE}": True}`,
        "else:",
        '    context["flow_plan"].context["prompt_data"] = {}',
        "return True",
      ].join("\n"),
    );
  });
});

describe("pendingVerificationDenialExpression", () => {
  it("denies an inactive user unless they're still on their first, unverified sign-in", () => {
    expect(pendingVerificationDenialExpression()).toBe(
      [
        "if request.user.is_active:",
        "    return True",
        `if request.user.attributes.get("${PENDING_EMAIL_VERIFICATION_ATTRIBUTE}"):`,
        "    return True",
        'ak_message("This account has been deactivated. Contact info@cyccommunitysailing.org.")',
        "return False",
      ].join("\n"),
    );
  });
});

describe("clearPendingVerificationExpression", () => {
  it("clears the pending-verification attribute and saves only if it was set", () => {
    expect(clearPendingVerificationExpression()).toBe(
      [
        `if request.user.attributes.pop("${PENDING_EMAIL_VERIFICATION_ATTRIBUTE}", None) is not None:`,
        "    request.user.save()",
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
