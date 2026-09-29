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
 * The embedded outpost's `config` (`authentik.Outpost.config`, a JSON blob). Every key but
 * `authentik_host` is copied verbatim from the live outpost - Authentik's own blueprint reconciler
 * owns them, and this project has no reason to second-guess their values, only to pin the one key
 * that a blank default broke: the forward-auth redirect falling back to `http://localhost`.
 */
export function embeddedOutpostConfig(internalDomain: string): string {
  return JSON.stringify({
    authentik_host: `https://${loginHost(internalDomain)}`,
    authentik_host_insecure: false,
    authentik_host_browser: "",
    log_level: "info",
    object_naming_template: "ak-outpost-%(name)s",
    docker_labels: null,
    docker_network: null,
    docker_map_ports: true,
    container_image: null,
    refresh_interval: "minutes=5",
    kubernetes_replicas: 1,
    kubernetes_namespace: "default",
    kubernetes_ingress_class_name: null,
    kubernetes_ingress_secret_name: "authentik-outpost-tls",
    kubernetes_ingress_annotations: {},
    kubernetes_ingress_path_type: null,
    kubernetes_httproute_annotations: {},
    kubernetes_httproute_parent_refs: [],
    kubernetes_service_type: "ClusterIP",
    kubernetes_disabled_components: [],
    kubernetes_disable_x509_strict: false,
    kubernetes_image_pull_secrets: [],
    kubernetes_json_patches: null,
  });
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
 * The Python expression body for the "any signed-in user" policy gating the portal's and Directus's
 * applications. Authentik 2026.8 denies access to an application with no policy bound at all, so
 * this is the whole access decision at the gate - each application's own data layer (Directus's
 * permission rules, the portal's Google-Groups sections) decides what a signed-in user can see from
 * there. `ak_message` is Authentik's own mechanism for a failing policy to set the text shown on the
 * resulting "Permission denied" page.
 */
export function signedInPolicyExpression(): string {
  return [
    "if request.user.is_authenticated:",
    "    return True",
    'ak_message("We couldn\'t sign you in to this page. Use the email you registered with in Clubspot, or write to info@cyccommunitysailing.org.")',
    "return False",
  ].join("\n");
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
