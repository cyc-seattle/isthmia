import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { artifactRepositoryUrl } from "./artifact-repository";
import { location, projectId } from "./config";
import { internalDomain } from "./dns";

// Cloud-init (COS `user-data`) that boots the cycsail.team portal compose stack on the substrate VM.
// Kept separate from compute.ts so the VM slice can consume it without importing the portal slice
// (which imports compute.ts) — that would be a cycle. The committed compose file is the single
// source of truth; it is embedded verbatim and the secrets are fetched at boot from Secret Manager
// using the VM's own service account (no key files land in the image or git).

const config = new pulumi.Config();
const authGroup = config.get("portalAuthGroup") ?? "all@cyccommunitysailing.org";
// A Workspace admin the VM's service account impersonates (via domain-wide delegation) for the
// Directory API group lookup. See packages/portal/README.md.
const authAdminEmail = config.get("portalAuthAdminEmail") ?? "master@cyccommunitysailing.org";
const registryHost = `${location}-docker.pkg.dev`;

const imageUrl = pulumi.interpolate`${artifactRepositoryUrl}/portal:latest`;

// The compose stack lives with the app. Resolve it relative to this module (via __dirname; this
// package compiles to CommonJS) rather than the process cwd, so it works however Pulumi is invoked:
// <dir> -> infrastructure -> packages -> portal.
const composeContent = readFileSync(resolve(__dirname, "../../portal/deploy/docker-compose.yml"), "utf8").trimEnd();

const indent = (text: string, spaces: number): string =>
  text
    .split("\n")
    .map((line) => (line.length ? " ".repeat(spaces) + line : line))
    .join("\n");

// Shell runs at first boot. `$VAR` / `$(...)` are shell (no `${` so template literals leave them
// alone); the interpolated `${...}` values are plain build-time strings.
function bootstrapScript(image: string): string {
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    "exec >> /var/log/portal-bootstrap.log 2>&1",
    "mkdir -p /var/portal",
    "META=http://metadata.google.internal/computeMetadata/v1",
    `TOKEN=$(curl -s -H 'Metadata-Flavor: Google' "$META/instance/service-accounts/default/token" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)`,
    // The optional space after the colon matters: Secret Manager pretty-prints its JSON responses
    // (unlike the metadata server's compact token JSON above).
    "fetch_secret() {",
    `  curl -s -H "Authorization: Bearer $TOKEN" "https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/$1/versions/latest:access" | grep -o '"data": *"[^"]*"' | cut -d'"' -f4 | base64 -d`,
    "}",
    "cat > /var/portal/portal.env <<EOF",
    `PORTAL_IMAGE=${image}`,
    `SITE_DOMAIN=${internalDomain}`,
    `OAUTH2_PROXY_GOOGLE_GROUP=${authGroup}`,
    `OAUTH2_PROXY_GOOGLE_ADMIN_EMAIL=${authAdminEmail}`,
    "OAUTH2_PROXY_CLIENT_ID=$(fetch_secret portal-oauth-client-id)",
    "OAUTH2_PROXY_CLIENT_SECRET=$(fetch_secret portal-oauth-client-secret)",
    // oauth2-proxy only decodes URL-safe base64; translate the alphabet in case the stored value
    // was generated as standard base64 (same 32 bytes either way).
    "OAUTH2_PROXY_COOKIE_SECRET=$(fetch_secret portal-oauth-cookie-secret | tr -- '+/' '-_')",
    "EOF",
    // A fetch_secret failure inside the heredoc's command substitution doesn't trip `set -e`; it
    // just writes an empty value. Fail loudly instead of booting oauth2-proxy without credentials.
    "for key in OAUTH2_PROXY_CLIENT_ID OAUTH2_PROXY_CLIENT_SECRET OAUTH2_PROXY_COOKIE_SECRET; do",
    '  grep -q "^$key=.\\+" /var/portal/portal.env || { echo "$key is empty; secret fetch failed"; exit 1; }',
    "done",
    // COS mounts the root filesystem read-only, so docker's default config path (/root/.docker) is
    // unwritable; keep credentials under /var/portal instead.
    "mkdir -p /var/portal/.docker",
    "export DOCKER_CONFIG=/var/portal/.docker",
    `docker login -u oauth2accesstoken -p "$TOKEN" https://${registryHost}`,
    // Prefer the compose v2 plugin, then the standalone binary. COS ships neither, so the last
    // resort runs compose out of the docker:cli image against the host socket, with the registry
    // credentials mounted where the containerized client expects them.
    "if docker compose version >/dev/null 2>&1; then DC='docker compose';",
    "elif command -v docker-compose >/dev/null 2>&1; then DC='docker-compose';",
    "else DC='docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v /var/portal:/var/portal -v /var/portal/.docker:/root/.docker docker:cli compose'; fi",
    "$DC --project-directory /var/portal --env-file /var/portal/portal.env -f /var/portal/docker-compose.yml pull",
    "$DC --project-directory /var/portal --env-file /var/portal/portal.env -f /var/portal/docker-compose.yml up -d",
  ].join("\n");
}

function cloudConfig(image: string): string {
  return [
    "#cloud-config",
    "",
    "write_files:",
    "  - path: /var/portal/docker-compose.yml",
    '    permissions: "0644"',
    "    content: |",
    indent(composeContent, 6),
    "  - path: /var/portal/bootstrap.sh",
    '    permissions: "0755"',
    "    content: |",
    indent(bootstrapScript(image), 6),
    "",
    "runcmd:",
    "  - ['/bin/bash', '/var/portal/bootstrap.sh']",
    "",
  ].join("\n");
}

/** COS `user-data` that stands up the portal on first boot. */
export const substrateUserData: pulumi.Output<string> = imageUrl.apply(cloudConfig);
