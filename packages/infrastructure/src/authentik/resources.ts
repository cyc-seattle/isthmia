import * as pulumi from "@pulumi/pulumi";
import * as authentik from "@pulumi/authentik";

// Thin subclasses over the goauthentik Terraform bridge's resources, each pinning one secure
// default this project relies on - same shape as ../infrastructure/secret.ts's Secret/randomSecret.

/** A Google social-login source: `userMatchingMode: "email_link"` links a pre-created Authentik
 * user by matching email, never by any looser mode. A caller still supplies `enrollmentFlow`, so
 * a Google sign-in from an email with no pre-created user falls through to that (no-group) flow
 * instead of failing outright. */
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
    super(name, { ...args, clientType: "confidential" }, opts);
  }
}

/** A non-interactive machine account - `serviceAccount` so it can never sign in with a password
 * and never appears as a real staff or family login. */
export class ServiceAccountUser extends authentik.User {
  constructor(name: string, args: Omit<authentik.UserArgs, "type">, opts?: pulumi.CustomResourceOptions) {
    super(name, { ...args, type: "service_account" }, opts);
  }
}

/** A non-expiring API token with its key actually readable back - `retrieveKey` must be `true` or
 * Authentik never returns the plaintext value at all. */
export class ServiceAccountToken extends authentik.Token {
  constructor(
    name: string,
    args: Omit<authentik.TokenArgs, "intent" | "retrieveKey" | "expiring">,
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(name, { ...args, intent: "api", retrieveKey: true, expiring: false }, opts);
  }
}

/** The enrollment flow's user-write stage: `internal` (never `external`/`service_account`, which
 * are for staff/machine accounts), never inactive (the very next stage is user_login, so an
 * inactive user would be created only to immediately fail to sign in), and never in a group -
 * `createUsersGroup` stays omitted so a caller can't accidentally grant one. */
export class EnrollmentUserWriteStage extends authentik.StageUserWrite {
  constructor(
    name: string,
    args: Omit<authentik.StageUserWriteArgs, "userType" | "createUsersAsInactive" | "createUsersGroup">,
    opts?: pulumi.CustomResourceOptions,
  ) {
    super(name, { ...args, userType: "internal", createUsersAsInactive: false }, opts);
  }
}
