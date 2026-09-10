// Pure string-templating for the substrate VM's cloud-init — deliberately free of any `@pulumi/*`
// import so it can be unit tested with plain function calls (see substrate-bootstrap.ts, which
// resolves the real pulumi.Output values and calls into here).

export const indent = (text: string, spaces: number): string =>
  text
    .split("\n")
    .map((line) => (line.length ? " ".repeat(spaces) + line : line))
    .join("\n");

export interface BootstrapScriptParams {
  image: string;
  directusDbHost: string;
  projectId: string;
  siteDomain: string;
  crmDomain: string;
  authGroup: string;
  authAdminEmail: string;
  directusAdminEmail: string;
  registryHost: string;
  /** Matches `docker compose`'s default project-naming (basename of `--project-directory`, below) —
   * needed by the container-cleanup step too. */
  composeProjectName: string;
}

// Shell runs at first boot. `$VAR` / `$(...)` are shell (no `${` so template literals leave them
// alone); the interpolated `${...}` values are plain build-time strings.
export function bootstrapScript(params: BootstrapScriptParams): string {
  const {
    image,
    directusDbHost,
    projectId,
    siteDomain,
    crmDomain,
    authGroup,
    authAdminEmail,
    directusAdminEmail,
    registryHost,
    composeProjectName,
  } = params;
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "exec >> /var/log/substrate-bootstrap.log 2>&1",
    "mkdir -p /var/substrate",
    "META=http://metadata.google.internal/computeMetadata/v1",
    `TOKEN=$(curl -s -H 'Metadata-Flavor: Google' "$META/instance/service-accounts/default/token" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)`,
    // The optional space after the colon matters: Secret Manager pretty-prints its JSON responses
    // (unlike the metadata server's compact token JSON above).
    "fetch_secret() {",
    `  curl -s -H "Authorization: Bearer $TOKEN" "https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/$1/versions/latest:access" | grep -o '"data": *"[^"]*"' | cut -d'"' -f4 | base64 -d`,
    "}",
    "cat > /var/substrate/substrate.env <<EOF",
    `CADDY_IMAGE=${image}`,
    `SITE_DOMAIN=${siteDomain}`,
    `CRM_DOMAIN=${crmDomain}`,
    `OAUTH2_PROXY_GOOGLE_GROUP=${authGroup}`,
    `OAUTH2_PROXY_GOOGLE_ADMIN_EMAIL=${authAdminEmail}`,
    // One Google OAuth client, shared by oauth2-proxy (portal) and Directus's native OIDC (people
    // hub) — signing in once signs into both. See substrate.ts.
    "GOOGLE_OAUTH_CLIENT_ID=$(fetch_secret google-oauth-client-id)",
    "GOOGLE_OAUTH_CLIENT_SECRET=$(fetch_secret google-oauth-client-secret)",
    // oauth2-proxy only decodes URL-safe base64; translate the alphabet in case the stored value
    // was generated as standard base64 (same 32 bytes either way).
    "OAUTH2_PROXY_COOKIE_SECRET=$(fetch_secret portal-oauth-cookie-secret | tr -- '+/' '-_')",
    `DIRECTUS_DB_HOST=${directusDbHost}`,
    `DIRECTUS_ADMIN_EMAIL=${directusAdminEmail}`,
    "DIRECTUS_KEY=$(fetch_secret directus-key)",
    "DIRECTUS_SECRET=$(fetch_secret directus-secret)",
    "DIRECTUS_DB_PASSWORD=$(fetch_secret directus-db-password)",
    "DIRECTUS_ADMIN_PASSWORD=$(fetch_secret directus-admin-bootstrap-password)",
    // Optional: Directus runs on the Core tier if empty. See docs/manual-setup.md §6.
    "DIRECTUS_LICENSE_KEY=$(fetch_secret directus-license-key || true)",
    "EOF",
    // A fetch_secret failure inside the heredoc's command substitution doesn't trip `set -e`; it
    // just writes an empty value. Fail loudly instead of booting a service without credentials
    // (DIRECTUS_LICENSE_KEY excepted — optional, see above).
    "for key in GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET OAUTH2_PROXY_COOKIE_SECRET \\",
    "           DIRECTUS_KEY DIRECTUS_SECRET DIRECTUS_DB_PASSWORD DIRECTUS_ADMIN_PASSWORD; do",
    '  grep -q "^$key=.\\+" /var/substrate/substrate.env || { echo "$key is empty; secret fetch failed"; exit 1; }',
    "done",
    // COS mounts the root filesystem read-only, so docker's default config path (/root/.docker) is
    // unwritable; keep credentials under /var/substrate instead.
    "mkdir -p /var/substrate/.docker",
    "export DOCKER_CONFIG=/var/substrate/.docker",
    `docker login -u oauth2accesstoken -p "$TOKEN" https://${registryHost}`,
    // Tear down any container left over from a *different* compose project before bringing this
    // one up. Concretely: the `portal` project (pre-substrate-rename) never got torn down and kept
    // holding host ports 80/443, so this project's own caddy container failed to bind them — plausibly
    // interrupting Directus mid-bootstrap, before it got to seeding the admin user (see #99). A
    // container's compose project is a label, independent of which compose CLI created it, so this
    // doesn't need the same v2-plugin/standalone/containerized detection as the invocation below.
    `for cid in $(docker ps -aq); do`,
    `  project=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$cid" 2>/dev/null || true)`,
    `  if [ -n "$project" ] && [ "$project" != "${composeProjectName}" ]; then docker rm -f "$cid" || true; fi`,
    `done`,
    // Prefer the compose v2 plugin, then the standalone binary. COS ships neither, so the last
    // resort runs compose out of the docker:cli image against the host socket, with the registry
    // credentials mounted where the containerized client expects them.
    "if docker compose version >/dev/null 2>&1; then DC='docker compose';",
    "elif command -v docker-compose >/dev/null 2>&1; then DC='docker-compose';",
    "else DC='docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v /var/substrate:/var/substrate -v /var/substrate/.docker:/root/.docker docker:cli compose'; fi",
    "$DC --project-directory /var/substrate --env-file /var/substrate/substrate.env -f /var/substrate/docker-compose.yml pull",
    "$DC --project-directory /var/substrate --env-file /var/substrate/substrate.env -f /var/substrate/docker-compose.yml up -d",
  ].join("\n");
}

export interface CloudConfigParams extends BootstrapScriptParams {
  composeContent: string;
}

export function cloudConfig(params: CloudConfigParams): string {
  return [
    "#cloud-config",
    "",
    "write_files:",
    "  - path: /var/substrate/docker-compose.yml",
    '    permissions: "0644"',
    "    content: |",
    indent(params.composeContent, 6),
    "  - path: /var/substrate/bootstrap.sh",
    '    permissions: "0755"',
    "    content: |",
    indent(bootstrapScript(params), 6),
    "",
    "runcmd:",
    "  - ['/bin/bash', '/var/substrate/bootstrap.sh']",
    "",
  ].join("\n");
}
