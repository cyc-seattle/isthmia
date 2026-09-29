// Pure helpers factored out of index.ts so the hostnames and the OIDC scope mapping's expression
// are each testable without standing up Pulumi or a live Authentik instance.

/** The Authentik group the portal's staff sections gate on, read from the `X-Authentik-Groups`
 * header the embedded outpost sets on a forward-authed request. Membership is managed by hand. */
export const STAFF_GROUP_NAME = "staff";

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
 * `people.email`, itself normalized by clubspot-sync, so both sides of that comparison need the
 * same normalization.
 */
export function lowercaseEmailScopeExpression(): string {
  return 'return {"email": request.user.email.lower()}';
}

/**
 * The Python expression body for the enrollment flow's prompt-stage validation policy. Mutating
 * `prompt_data` in place is Authentik's own mechanism for a validation policy to normalize
 * submitted values before the next stage reads them. Lowercases the submitted email (see
 * `lowercaseEmailScopeExpression` - the same normalization Directus's claim applies) and reuses it
 * as the username, since the enrollment prompt collects only an email.
 */
export function enrollmentNormalizeExpression(): string {
  return [
    'prompt_data = request.context["prompt_data"]',
    'prompt_data["email"] = prompt_data["email"].lower()',
    'prompt_data["username"] = prompt_data["email"]',
    "return True",
  ].join("\n");
}
