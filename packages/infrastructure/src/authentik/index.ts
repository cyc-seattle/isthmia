import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as authentik from "@pulumi/authentik";
import {
  GoogleSource,
  ForwardAuthProvider,
  ConfidentialOidcProvider,
  ServiceAccountUser,
  ServiceAccountToken,
} from "./resources";
import { internalDomain } from "./refs";
import {
  loginHost,
  previewExternalHost,
  directusRedirectUri,
  lowercaseEmailScopeExpression,
  communitySyncPermissions,
  STAFF_GROUP_NAME,
  FAMILIES_GROUP_NAME,
} from "./naming";
import { Secret } from "../infrastructure/secret";
import { enableService } from "../services";

// Authentik's own configuration: sources, flows, groups, and applications, on top of the
// container/database/DNS infrastructure.ts's authentik.ts already stands up. Applied after
// infrastructure (per scripts/deploy), and before crm - Directus's `authentik` auth provider
// (a later change) needs the OIDC application declared here to already exist.
//
// Every resource below is created through the `authentik` Terraform-bridged provider
// (pulumi package add terraform-provider goauthentik/authentik, pinned to 2026.8.0 to match the
// Authentik release infrastructure.ts's containers run), not GCP's - `provider: authentikProvider`
// is threaded through every resource's opts for that reason.

const secretmanagerApi = enableService("secretmanager.googleapis.com");

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

// Terraform ids are always strings, but a handful of Authentik fields (an Application's or an
// OutpostProviderAttachment's `protocolProvider`, a Token's `user`) are typed as the underlying
// Django numeric pk - unlike Group/Flow/Stage/User, which use a UUID pk that stays a string
// end-to-end.
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

// --- 1. The Google source: email-based user matching only, so a Google sign-in links a
// pre-created Authentik user with the same email and never creates one (see GoogleSource's own
// doc comment for why `enrollmentFlow` stays unset).
const googleSource = new GoogleSource(
  "google",
  {
    name: "Google",
    slug: "google",
    consumerKey: secretValue("authentik-google-client-id"),
    consumerSecret: secretValue("authentik-google-client-secret"),
    authenticationFlow: sourceAuthenticationFlow.id,
  },
  opts,
);

// --- 2. The email-code sign-in flow: identification (no password stage, so it never asks for
// one) -> an email stage sending a sign-in link -> login. A full flow of our own, rather than
// stages grafted onto Authentik's built-in default-authentication-flow, so this project never
// races the blueprint reconciler that owns that flow's own bindings.
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
    // and "enter your email" are the only two ways in.
    userFields: ["email"],
    sources: [googleSource.id],
  },
  opts,
);

const emailStage = new authentik.StageEmail(
  "email-code-email",
  {
    name: "Email code: email",
    subject: "Sign in to CYC Community Sailing Center",
    // The container already carries the Workspace SMTP relay settings (AUTHENTIK_EMAIL__*); this
    // stage reuses them rather than repeating the relay host/port here.
    useGlobalSettings: true,
  },
  opts,
);

const loginStage = new authentik.StageUserLogin("email-code-login", { name: "Email code: login" }, opts);

const emailCodeStages = [identificationStage, emailStage, loginStage];
emailCodeStages.forEach((stage, index) => {
  new authentik.FlowStageBinding(
    `email-code-binding-${index}`,
    { target: emailCodeFlow.id, stage: stage.id, order: (index + 1) * 10 },
    opts,
  );
});

// A Brand matching the login host exactly is how this flow becomes "the" authentication flow a
// browser reaches at that host - Authentik picks the most specific domain match regardless of
// `default`, so this doesn't touch the placeholder default brand Authentik ships at first boot.
new authentik.Brand(
  "login",
  { domain: internalDomain.apply((domain) => loginHost(domain)), flowAuthentication: emailCodeFlow.id },
  opts,
);

// --- 3. Users cannot change their own email. Already Authentik's shipped default; declared
// explicitly so a future Authentik upgrade changing that default can't silently reopen it.
new authentik.SystemSettings("system-settings", { defaultUserChangeEmail: false }, opts);

// --- 4. Groups.
const staffGroup = new authentik.Group(STAFF_GROUP_NAME, { name: STAFF_GROUP_NAME }, opts);
const familiesGroup = new authentik.Group(FAMILIES_GROUP_NAME, { name: FAMILIES_GROUP_NAME }, opts);

// --- 5. The portal's forward-auth proxy provider and application, on the embedded outpost -
// external_host stays at preview.<internalDomain> until the cutover step moves it to the apex.
const portalProxyProvider = new ForwardAuthProvider(
  "portal-proxy",
  {
    name: "Portal",
    externalHost: internalDomain.apply((domain) => previewExternalHost(domain)),
    authorizationFlow: implicitConsentFlow.id,
    invalidationFlow: providerInvalidationFlow.id,
  },
  opts,
);

new authentik.Application(
  "portal",
  {
    name: "Portal",
    slug: "portal",
    protocolProvider: numericId(portalProxyProvider.providerProxyId),
  },
  opts,
);

// The embedded outpost every Authentik instance ships with at first boot - looked up, not
// managed, same reasoning as the built-in flows above.
const embeddedOutpost = authentik.getOutpostOutput({ name: "authentik Embedded Outpost" }, invokeOpts);

new authentik.OutpostProviderAttachment(
  "portal-outpost-attachment",
  { outpost: embeddedOutpost.id, protocolProvider: numericId(portalProxyProvider.providerProxyId) },
  opts,
);

// --- 6. The Directus OIDC provider and application. The client secret is generated once, in
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

new authentik.Application(
  "directus",
  { name: "Directus", slug: "directus", protocolProvider: numericId(directusProvider.providerOauth2Id) },
  opts,
);

// --- 7. community-sync's service account: create users, and manage membership of exactly the
// two groups above - nothing broader.
const communitySyncRole = new authentik.RbacRole("community-sync", { name: "community-sync" }, opts);

// Labels line up positionally with communitySyncPermissions's own return order (global grant,
// then staff, then families) - the naming test pins that order.
const communitySyncGrantLabels = ["global", "staff", "families"];
communitySyncPermissions(staffGroup.groupId, familiesGroup.groupId).forEach((grant, index) => {
  new authentik.RbacPermissionRole(
    `community-sync-${communitySyncGrantLabels[index]}`,
    {
      role: communitySyncRole.rbacRoleId,
      permission: grant.permission,
      ...(grant.model !== undefined ? { model: grant.model } : {}),
      ...(grant.objectId !== undefined ? { objectId: grant.objectId } : {}),
    },
    opts,
  );
});

const communitySyncUser = new ServiceAccountUser(
  "community-sync",
  { username: "community-sync", name: "community-sync", roles: [communitySyncRole.rbacRoleId] },
  opts,
);

const communitySyncToken = new ServiceAccountToken(
  "community-sync-token",
  {
    identifier: "community-sync",
    user: numericId(communitySyncUser.userId),
    description: "community-sync job's Authentik API token",
  },
  opts,
);

// The token's value only exists once Authentik generates it above, so (unlike the Directus OIDC
// secret) its container and version are declared here rather than in ../infrastructure - granted
// to the community-sync job's own service account when that job is stood up.
const communitySyncTokenSecret = new Secret("community-sync-authentik-token", { dependsOn: secretmanagerApi });
new gcp.secretmanager.SecretVersion(
  "community-sync-authentik-token-version",
  { secret: communitySyncTokenSecret.id, secretData: communitySyncToken.key },
  { dependsOn: communitySyncTokenSecret },
);
