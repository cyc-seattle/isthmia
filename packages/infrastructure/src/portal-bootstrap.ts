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
    "fetch_secret() {",
    `  curl -s -H "Authorization: Bearer $TOKEN" "https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/$1/versions/latest:access" | grep -o '"data":"[^"]*"' | cut -d'"' -f4 | base64 -d`,
    "}",
    "cat > /var/portal/portal.env <<EOF",
    `PORTAL_IMAGE=${image}`,
    `SITE_DOMAIN=${internalDomain}`,
    `OAUTH2_PROXY_GOOGLE_GROUP=${authGroup}`,
    `OAUTH2_PROXY_GOOGLE_ADMIN_EMAIL=${authAdminEmail}`,
    "OAUTH2_PROXY_CLIENT_ID=$(fetch_secret portal-oauth-client-id)",
    "OAUTH2_PROXY_CLIENT_SECRET=$(fetch_secret portal-oauth-client-secret)",
    "OAUTH2_PROXY_COOKIE_SECRET=$(fetch_secret portal-oauth-cookie-secret)",
    "EOF",
    `docker login -u oauth2accesstoken -p "$TOKEN" https://${registryHost}`,
    // Prefer the compose v2 plugin; fall back to the standalone binary if that's what the host has.
    "if docker compose version >/dev/null 2>&1; then DC='docker compose'; else DC='docker-compose'; fi",
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
