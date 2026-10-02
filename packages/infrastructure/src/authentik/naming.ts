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
 * permission rules, the portal's Authentik-group-gated sections) decides what a signed-in user can
 * see from there. `ak_message` is Authentik's own mechanism for a failing policy to set the text
 * shown on the resulting "Permission denied" page.
 */
export function signedInPolicyExpression(): string {
  return [
    "if request.user.is_authenticated:",
    "    return True",
    'ak_message("We couldn\'t sign you in to this page. Use the email you registered with in Clubspot, or write to info@cyccommunitysailing.org.")',
    "return False",
  ].join("\n");
}

/** The attribute the sign-in flow's user-write stage sets, via `signInNormalizeExpression`'s
 * `prompt_data`, on a user it's creating for the first time - and clears again, via
 * `clearPendingVerificationExpression`, once they click through the sign-in email. Its presence is
 * what lets `pendingVerificationDenialExpression` tell a first-time signer who hasn't verified yet
 * from a user an admin deactivated after they had. */
export const PENDING_EMAIL_VERIFICATION_ATTRIBUTE = "cyc_pending_email_verification";

/**
 * The Python expression body for a policy bound to the sign-in flow's user-write stage binding,
 * re-evaluated on every request (`evaluateOnPlan` off, `reEvaluatePolicies` on) so `request.user`
 * is identification's pending user - the real match, or Authentik's own placeholder for an
 * unmatched email.
 *
 * The placeholder (`pk` unset) is written: its lowercased email becomes `username`, `email`, and
 * `attributes.<PENDING_EMAIL_VERIFICATION_ATTRIBUTE>`, and it is popped from the plan so
 * `create_when_required` takes its create-a-new-user path instead of silently skipping the save.
 * A matched user (`pk` set) gets an empty `prompt_data` - no rename, no email change, before the
 * address is verified.
 */
export function signInNormalizeExpression(): string {
  return [
    "if not request.user.pk:",
    '    context["flow_plan"].context.pop("pending_user", None)',
    "    email = request.user.email.lower()",
    `    context["flow_plan"].context["prompt_data"] = {"username": email, "email": email, "attributes.${PENDING_EMAIL_VERIFICATION_ATTRIBUTE}": True}`,
    "else:",
    '    context["flow_plan"].context["prompt_data"] = {}',
    "return True",
  ].join("\n");
}

/**
 * The Python expression body for a policy bound to the sign-in flow's email stage binding, with
 * the same `evaluateOnPlan`/`reEvaluatePolicies` override as the write stage's own binding and for
 * the same reason - `request.user` needs to be the pending user identification and the write stage
 * just resolved, not whoever held the request when the flow's plan was first built. An inactive
 * user is denied unless `PENDING_EMAIL_VERIFICATION_ATTRIBUTE` is set: the write stage only sets it
 * on a user it just created, so its presence means "still on their first, unverified sign-in,"
 * while its absence on an inactive user means an admin turned the account off after it verified.
 */
export function pendingVerificationDenialExpression(): string {
  return [
    "if request.user.is_active:",
    "    return True",
    `if request.user.attributes.get("${PENDING_EMAIL_VERIFICATION_ATTRIBUTE}"):`,
    "    return True",
    'ak_message("This account has been deactivated. Contact info@cyccommunitysailing.org.")',
    "return False",
  ].join("\n");
}

/**
 * The Python expression body for a policy bound to the sign-in flow's login stage binding (same
 * override as above). The email stage only advances the plan this far after a successful
 * code/link click, so reaching here means the address is verified - clearing
 * `PENDING_EMAIL_VERIFICATION_ATTRIBUTE` now is what lets a later admin deactivation hold
 * (`pendingVerificationDenialExpression`).
 */
export function clearPendingVerificationExpression(): string {
  return [
    `if request.user.attributes.pop("${PENDING_EMAIL_VERIFICATION_ATTRIBUTE}", None) is not None:`,
    "    request.user.save()",
    "return True",
  ].join("\n");
}
