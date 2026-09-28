// Pure helpers factored out of index.ts so the hostnames, the RBAC grant set, and the OIDC scope
// mapping's expression are each testable without standing up Pulumi or a live Authentik instance.

/** The two Authentik groups community-sync writes membership into: every `all@` member goes in
 * `staff`, and every current participant or guardian's login goes in `families`. The portal reads
 * both from the `X-Authentik-Groups` header the embedded outpost sets on a forward-authed request. */
export const STAFF_GROUP_NAME = "staff";
export const FAMILIES_GROUP_NAME = "families";

/** `login.<internalDomain>` — the host Authentik itself serves, with no scheme (Authentik's own
 * `Brand.domain` and `SourceOauth` inputs both want a bare hostname, not a URL). */
export function loginHost(internalDomain: string): string {
  return `login.${internalDomain}`;
}

/** The portal's forward-auth host while it's staged at a preview subdomain, ahead of the eventual
 * cutover to the apex domain. */
export function previewExternalHost(internalDomain: string): string {
  return `https://preview.${internalDomain}`;
}

/** Where Directus's `authentik` OIDC auth provider expects Authentik to send the browser back. */
export function directusRedirectUri(internalDomain: string): string {
  return `https://directus.${internalDomain}/auth/login/authentik/callback`;
}

/**
 * The Python expression body for a scope mapping's `expression` field (Authentik evaluates this
 * server-side against each token request). Overrides the built-in `email` scope so every OIDC
 * client's `email` claim is already lowercased - Directus's Community role compares it against
 * `people.login_email`, itself lowercased by community-sync, so both sides of that comparison
 * need the same normalization.
 */
export function lowercaseEmailScopeExpression(): string {
  return 'return {"email": request.user.email.lower()}';
}

/** One RBAC grant: a global permission when `model`/`objectId` are omitted, or a permission scoped
 * to one specific row (Django's per-object permissions) when both are given. Generic over the
 * object id's type so this stays plain (no Pulumi import) while a caller can still pass a
 * `pulumi.Output<string>` group id straight through. */
export interface RbacGrant<Id = string> {
  model?: string;
  permission: string;
  objectId?: Id;
}

/**
 * The community-sync service account's whole RBAC grant set: create users, plus manage membership
 * of exactly the two groups it syncs - no broader `authentik_core.group` access, and nothing
 * outside `authentik_core` at all.
 */
export function communitySyncPermissions<Id>(staffGroupId: Id, familiesGroupId: Id): RbacGrant<Id>[] {
  return [
    { permission: "authentik_core.add_user" },
    { model: "authentik_core.group", permission: "authentik_core.change_group", objectId: staffGroupId },
    { model: "authentik_core.group", permission: "authentik_core.change_group", objectId: familiesGroupId },
  ];
}
