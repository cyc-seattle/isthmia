import * as pulumi from "@pulumi/pulumi";
import * as authentik from "@pulumi/authentik";

// Thin subclasses over the goauthentik Terraform bridge's resources, each pinning one secure
// default this project relies on - same shape as ../infrastructure/secret.ts's Secret/randomSecret.

/** A Google social-login source: `userMatchingMode: "email_link"` matches an existing Authentik
 * user by email only, never by any looser mode. A Google sign-in from an unmatched email falls
 * through to the caller's `enrollmentFlow` instead of failing outright. */
export class GoogleSource extends authentik.SourceOauth {
  constructor(
    name: string,
    args: Omit<authentik.SourceOauthArgs, "providerType" | "userMatchingMode">,
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(name, { ...args, providerType: "google", userMatchingMode: "email_link" }, opts);
  }
}

/** A forward-auth proxy provider for exactly one external host - `forwardSingle` gates a single
 * site (the portal), as opposed to `forwardDomain`'s whole-domain SSO cookie. */
export class ForwardAuthProvider extends authentik.ProviderProxy {
  constructor(name: string, args: Omit<authentik.ProviderProxyArgs, "mode">, opts?: pulumi.CustomResourceOptions) {
    super(name, { ...args, mode: "forward_single" }, opts);
  }
}

/** A confidential OIDC client - one that can hold a secret and authenticates itself on every token
 * request, never `public` (which skips client authentication entirely). */
export class ConfidentialOidcProvider extends authentik.ProviderOauth2 {
  constructor(
    name: string,
    args: Omit<authentik.ProviderOauth2Args, "clientType">,
    opts?: pulumi.CustomResourceOptions,
  ) {
    // Left unset, Authentik 2026.8 allows no grant at all, so every sign-in fails as malformed.
    super(name, { ...args, clientType: "confidential", grantTypes: ["authorization_code", "refresh_token"] }, opts);
  }
}

/** The sign-in flow's user-write stage: `internal` (never `external`/`service_account`, which are
 * for staff/machine accounts), never in a group - `createUsersGroup` stays omitted so a caller
 * can't accidentally grant one - and always `createUsersAsInactive`, because the stage that
 * follows it is the email stage, the only thing allowed to activate a first-time signer. */
export class UnverifiedEmailUserWriteStage extends authentik.StageUserWrite {
  constructor(
    name: string,
    args: Omit<authentik.StageUserWriteArgs, "userType" | "createUsersAsInactive" | "createUsersGroup">,
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(name, { ...args, userType: "internal", createUsersAsInactive: true }, opts);
  }
}

/** A source's own enrollment flow's user-write stage: same as `UnverifiedEmailUserWriteStage`, but
 * never inactive - a source is only bound here (see `GoogleSource`'s own doc comment) once it's
 * already proven the address itself, and the very next stage is user_login, so an inactive user
 * would be created only to immediately fail to sign in. */
export class VerifiedEmailUserWriteStage extends authentik.StageUserWrite {
  constructor(
    name: string,
    args: Omit<authentik.StageUserWriteArgs, "userType" | "createUsersAsInactive" | "createUsersGroup">,
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(name, { ...args, userType: "internal", createUsersAsInactive: false }, opts);
  }
}
