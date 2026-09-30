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
 * The Python expression body for a policy bound directly to the sign-in flow's user-write stage
 * binding, re-evaluated fresh every time the executor reaches that stage
 * (`FlowStageBinding.reEvaluatePolicies`, with `evaluateOnPlan` off so it never runs against the
 * request's real, anonymous user before identification has set one). `request.user` there is
 * identification's pending user - the real matched user, or, for an unmatched email, an unsaved
 * placeholder holding just that email (Authentik's "pretend user exists" behavior, needed so an
 * unknown email signs in instead of failing at identification, per #166). Lowercases that email
 * into both fields and writes them straight into the plan's `prompt_data`, since no prompt stage
 * runs here to set it and the write stage requires the key to exist at all.
 *
 * For the placeholder only (`pk` unset), also drops it from the plan. Left in place, the write
 * stage would treat it as an existing pending user, find its own normalization changed nothing
 * (the placeholder already carries the email as its username), and skip the save outright -
 * leaving an unsaved user for the email stage to crash on. Dropping it instead makes
 * `create_when_required` take its own create-a-new-user path, which always saves.
 */
export function signInNormalizeExpression(): string {
  return [
    "email = request.user.email.lower()",
    "if not request.user.pk:",
    '    context["flow_plan"].context.pop("pending_user", None)',
    'context["flow_plan"].context["prompt_data"] = {"username": email, "email": email}',
    "return True",
  ].join("\n");
}
