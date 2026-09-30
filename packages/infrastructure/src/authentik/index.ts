import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as authentik from "@pulumi/authentik";
import {
  GoogleSource,
  ForwardAuthProvider,
  ConfidentialOidcProvider,
  UnverifiedEmailUserWriteStage,
  VerifiedEmailUserWriteStage,
} from "./resources";
import { internalDomain } from "./refs";
import {
  loginHost,
  directusRedirectUri,
  lowercaseEmailScopeExpression,
  signInNormalizeExpression,
  signedInPolicyExpression,
  embeddedOutpostConfig,
  STAFF_GROUP_NAME,
} from "./naming";

// Authentik's own configuration: sources, flows, groups, and applications, on top of the
// container/database/DNS infrastructure.ts's authentik.ts already stands up. Applied after
// infrastructure (per scripts/deploy), and before crm - Directus's `authentik` auth provider
// (a later change) needs the OIDC application declared here to already exist.
//
// Every resource below is created through the `authentik` Terraform-bridged provider
// (pulumi package add terraform-provider goauthentik/authentik, pinned to 2026.8.0 to match the
// Authentik release infrastructure.ts's containers run), not GCP's - `provider: authentikProvider`
// is threaded through every resource's opts for that reason.

// Reads a secret's value by its literal name, the way ../crm/index.ts reads the Directus admin
// bootstrap password - avoids a cross-project StackReference for a value that must never become a
// stack output.
function secretValue(secret: string): pulumi.Output<string> {
  return pulumi.secret(gcp.secretmanager.getSecretVersionOutput({ secret }).apply((version) => version.secretData));
}

const authentikProvider = new authentik.Provider("authentik", {
  url: internalDomain.apply((domain) => `https://${loginHost(domain)}`),
  token: secretValue("authentik-bootstrap-token"),
});
const opts = { provider: authentikProvider };
const invokeOpts = { provider: authentikProvider };

// Terraform ids are always strings, but a handful of Authentik fields (an Application's
// `protocolProvider`, an Outpost's `protocolProviders`, a Token's `user`) are typed as the
// underlying Django numeric pk - unlike Group/Flow/Stage/User, which use a UUID pk that stays a
// string end-to-end.
function numericId(id: pulumi.Input<string>): pulumi.Output<number> {
  return pulumi.output(id).apply((value) => Number(value));
}

// --- Well-known built-in flows every provider below needs. Looked up rather than managed, so this
// project never fights Authentik's own first-boot blueprint for objects it doesn't own.
const implicitConsentFlow = authentik.getFlowOutput(
  { slug: "default-provider-authorization-implicit-consent" },
  invokeOpts,
);
const providerInvalidationFlow = authentik.getFlowOutput({ slug: "default-provider-invalidation-flow" }, invokeOpts);
const sourceAuthenticationFlow = authentik.getFlowOutput({ slug: "default-source-authentication" }, invokeOpts);
// Without a signing key, ID tokens are HS256-signed with the client secret; Directus accepts RS256 only.
const signingCertificate = authentik.getCertificateKeyPairOutput(
  { name: "authentik Self-signed Certificate" },
  invokeOpts,
);

// --- 1. The Google source's own enrollment flow: write the user, then log in - nothing verifies
// the email because Google already has. A source's own enrollment flow needs no prompt stage
// either: `handle_enroll` (authentik/core/sources/flow_manager.py) populates the flow's prompt
// data itself and never pre-sets a pending user, so `create_when_required` takes its normal
// create-a-new-user path, active immediately, with this stage's own `createUsersAsInactive: false`.
const googleEnrollmentFlow = new authentik.Flow(
  "google-enrollment",
  { name: "Google sign-up", slug: "google-enrollment", title: "Create your account", designation: "enrollment" },
  opts,
);

const googleEnrollmentUserWriteStage = new VerifiedEmailUserWriteStage(
  "google-enrollment-user-write",
  { name: "Google enrollment: create account", userCreationMode: "create_when_required" },
  opts,
);

const googleEnrollmentLoginStage = new authentik.StageUserLogin(
  "google-enrollment-login",
  { name: "Google enrollment: login" },
  opts,
);

[googleEnrollmentUserWriteStage, googleEnrollmentLoginStage].forEach((stage, index) => {
  new authentik.FlowStageBinding(
    `google-enrollment-binding-${index}`,
    { target: googleEnrollmentFlow.uuid, stage: stage.id, order: (index + 1) * 10 },
    opts,
  );
});

// --- 2. The Google source: email-based user matching, falling through to the minimal enrollment
// flow above for a first sign-in from an unmatched email (see GoogleSource's own doc comment).
const googleSource = new GoogleSource(
  "google",
  {
    name: "Google",
    slug: "google",
    consumerKey: secretValue("google-oauth-client-id"),
    consumerSecret: secretValue("google-oauth-client-secret"),
    authenticationFlow: sourceAuthenticationFlow.id,
    enrollmentFlow: googleEnrollmentFlow.uuid,
  },
  opts,
);

// --- 3. The sign-in flow: one flow for both a returning and a first-time email, with no separate
// enrollment flow to fall through to (#166's live bug), and no visible screen between identifying
// the email and "check your email" either. Identification (no password stage, sources the Google
// button) always sets a pending user, matched or not - Authentik's own "pretend user exists"
// placeholder for an unmatched email - so an unsaved user reaches the write stage next either way.
// Rather than a prompt stage's validation policy (which still renders its own page, even with
// nothing but a hidden field), normalization runs as a policy bound directly to the write stage's
// own binding, re-evaluated on every request to it - see `signInNormalizeExpression`'s doc comment
// for why the placeholder case also has to leave the plan's pending user behind. The user-write
// stage right after commits it - updating the matched user in place, or, for the placeholder,
// inserting it for the first time, inactive - and only the email stage after that activates it, by
// a successful click-through. A full flow of our own, rather than stages grafted onto Authentik's
// built-in default-authentication-flow, so this project never races the blueprint reconciler that
// owns that flow's own bindings.
const emailCodeFlow = new authentik.Flow(
  "email-code-authentication",
  {
    name: "Email code authentication",
    slug: "email-code-authentication",
    title: "Sign in",
    designation: "authentication",
  },
  opts,
);

const identificationStage = new authentik.StageIdentification(
  "email-code-identification",
  {
    name: "Email code: identification",
    // Matches by email only, with no password stage bound - the Google button (via `sources`)
    // and "enter your email" are the only two ways in. No `enrollmentFlow`: an unmatched email
    // continues in this same flow instead of a "Sign up" link to a separate one.
    userFields: ["email"],
    sources: [googleSource.uuid],
  },
  opts,
);

const signInNormalizePolicy = new authentik.PolicyExpression(
  "sign-in-normalize-email",
  { name: "Sign-in: normalize the identified email", expression: signInNormalizeExpression() },
  opts,
);

const signInUserWriteStage = new UnverifiedEmailUserWriteStage(
  "sign-in-user-write",
  { name: "Email code: create or update account", userCreationMode: "create_when_required" },
  opts,
);

const emailStage = new authentik.StageEmail(
  "email-code-email",
  {
    name: "Email code: email",
    subject: "Sign in to CYC Community Sailing Center",
    template: "email/sign-in.html",
    // The container already carries the Workspace SMTP relay settings (AUTHENTIK_EMAIL__*); this
    // stage reuses them rather than repeating the relay host/port here.
    useGlobalSettings: true,
    // The only thing that activates a user the write stage above created inactive.
    activateUserOnSuccess: true,
  },
  opts,
);

const loginStage = new authentik.StageUserLogin("email-code-login", { name: "Email code: login" }, opts);

new authentik.FlowStageBinding(
  "email-code-binding-0",
  { target: emailCodeFlow.uuid, stage: identificationStage.id, order: 10 },
  opts,
);

// Re-evaluated on every request to this stage, not at plan-build time (before identification has
// set a pending user to normalize) - see `signInNormalizeExpression`'s doc comment.
const signInUserWriteBinding = new authentik.FlowStageBinding(
  "email-code-binding-1",
  {
    target: emailCodeFlow.uuid,
    stage: signInUserWriteStage.id,
    order: 20,
    evaluateOnPlan: false,
    reEvaluatePolicies: true,
  },
  opts,
);

new authentik.PolicyBinding(
  "sign-in-normalize-email-binding",
  { target: signInUserWriteBinding.id, policy: signInNormalizePolicy.id, order: 0 },
  opts,
);

new authentik.FlowStageBinding(
  "email-code-binding-2",
  { target: emailCodeFlow.uuid, stage: emailStage.id, order: 30 },
  opts,
);

new authentik.FlowStageBinding(
  "email-code-binding-3",
  { target: emailCodeFlow.uuid, stage: loginStage.id, order: 40 },
  opts,
);

// A Brand matching the login host exactly is how this flow becomes "the" authentication flow a
// browser reaches at that host - Authentik picks the most specific domain match regardless of
// `default`, so this doesn't touch the placeholder default brand Authentik ships at first boot.
new authentik.Brand(
  "login",
  { domain: internalDomain.apply((domain) => loginHost(domain)), flowAuthentication: emailCodeFlow.uuid },
  opts,
);

// --- 4. Users cannot change their own email. Already Authentik's shipped default; declared
// explicitly so a future Authentik upgrade changing that default can't silently reopen it.
new authentik.SystemSettings("system-settings", { defaultUserChangeEmail: false }, opts);

// --- 5. The `staff` group. Membership is managed by hand, not synced from anywhere.
new authentik.Group(STAFF_GROUP_NAME, { name: STAFF_GROUP_NAME }, opts);

// --- 6. The portal's forward-auth proxy provider and application, on the embedded outpost.
const portalProxyProvider = new ForwardAuthProvider(
  "portal-proxy",
  {
    name: "Portal",
    externalHost: internalDomain.apply((domain) => `https://${domain}`),
    authorizationFlow: implicitConsentFlow.id,
    invalidationFlow: providerInvalidationFlow.id,
  },
  opts,
);

const portalApplication = new authentik.Application(
  "portal",
  {
    name: "Portal",
    slug: "portal",
    protocolProvider: numericId(portalProxyProvider.providerProxyId),
  },
  opts,
);

// The embedded outpost's Authentik-assigned id (`GET /api/v3/outposts/instances/`), pinned here so
// the `import` option below adopts the live resource rather than creating a second outpost.
const EMBEDDED_OUTPOST_ID = "e26170ed-47d7-4dde-bbd2-1a4970a5f19c";

// The embedded outpost every Authentik instance ships with at first boot. Imported, via the
// `import` resource option, rather than created - Authentik's own blueprint reconciler
// (`managed: goauthentik.io/outposts/embedded`) still owns this resource, so adopting the live one
// keeps this project from standing up a second outpost or fighting that reconciler over it.
// `config`'s keys other than `authentik_host` are copied verbatim from the live outpost
// (`embeddedOutpostConfig`'s doc comment), so this never touches a key Authentik itself manages.
//
// `authentik_host` is the field that broke: it was blank, so the forward-auth redirect fell back
// to the container's own `http://localhost`. Pinning it here (rather than the manual PATCH this
// codifies) is what keeps it from regressing on the next Authentik upgrade or outpost recreation.
new authentik.Outpost(
  "embedded-outpost",
  {
    name: "authentik Embedded Outpost",
    protocolProviders: [numericId(portalProxyProvider.providerProxyId)],
    config: internalDomain.apply((domain) => embeddedOutpostConfig(domain)),
  },
  { ...opts, import: EMBEDDED_OUTPOST_ID },
);

// --- 7. The Directus OIDC provider and application. The client secret is generated once, in
// ../infrastructure/authentik.ts, so Authentik's config here and Directus's own `authentik` auth
// provider (a later change to directus.ts) read the same value by name.
const directusEmailScopeMapping = new authentik.PropertyMappingProviderScope(
  "directus-email-lowercase",
  { name: "Directus: email (lowercased)", scopeName: "email", expression: lowercaseEmailScopeExpression() },
  opts,
);
const openidScopeMapping = authentik.getPropertyMappingProviderScopeOutput(
  { managed: "goauthentik.io/providers/oauth2/scope-openid" },
  invokeOpts,
);
const profileScopeMapping = authentik.getPropertyMappingProviderScopeOutput(
  { managed: "goauthentik.io/providers/oauth2/scope-profile" },
  invokeOpts,
);

const directusProvider = new ConfidentialOidcProvider(
  "directus-oidc",
  {
    name: "Directus",
    clientId: "directus",
    clientSecret: secretValue("directus-oidc-client-secret"),
    signingKey: signingCertificate.id,
    authorizationFlow: implicitConsentFlow.id,
    invalidationFlow: providerInvalidationFlow.id,
    // matching_mode/url are Terraform's own snake_case keys for this field - the bridge passes a
    // Map(String) through verbatim rather than camelCasing its contents.
    allowedRedirectUris: [
      { matching_mode: "strict", url: internalDomain.apply((domain) => directusRedirectUri(domain)) },
    ],
    propertyMappings: [openidScopeMapping.id, profileScopeMapping.id, directusEmailScopeMapping.id],
  },
  opts,
);

const directusApplication = new authentik.Application(
  "directus",
  { name: "Directus", slug: "directus", protocolProvider: numericId(directusProvider.providerOauth2Id) },
  opts,
);

// --- 8. Authentik 2026.8 denies access to an application with no policy bound at all - the portal
// and Directus gates are meant to be "any signed-in user", so each needs this one bound explicitly.
// `target` takes the application's `uuid`, not its Terraform `id` (which Application uses for its
// slug) - the field the Application resource itself calls "Generated." rather than "ID of the
// object" is the one that's actually the object's pk.
const signedInPolicy = new authentik.PolicyExpression(
  "signed-in-users",
  { name: "Signed-in users", expression: signedInPolicyExpression() },
  opts,
);

new authentik.PolicyBinding(
  "portal-signed-in-binding",
  { target: portalApplication.uuid, policy: signedInPolicy.id, order: 0 },
  opts,
);

new authentik.PolicyBinding(
  "directus-signed-in-binding",
  { target: directusApplication.uuid, policy: signedInPolicy.id, order: 0 },
  opts,
);
