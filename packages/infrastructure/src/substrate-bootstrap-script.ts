// Pure string-templating for the substrate VM's apply/reconcile logic - no `@pulumi/*` import, so
// it's unit testable. Used by substrate-bootstrap.ts (cloud-init) and substrate-apply.ts (Pulumi
// remote-exec), which render the same `substrateFiles` manifest two ways.

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
  directusDomain: string;
  authGroup: string;
  authAdminEmail: string;
  directusAdminEmail: string;
  registryHost: string;
  /** Matches `docker compose`'s default project name; used by the cleanup step below. */
  composeProjectName: string;
}

// `/var/substrate/apply.sh`'s content. Idempotent - safe to re-run.
export function bootstrapScript(params: BootstrapScriptParams): string {
  const {
    image,
    directusDbHost,
    projectId,
    siteDomain,
    directusDomain,
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
    // Space after the colon matters: Secret Manager pretty-prints its JSON (unlike the token above).
    "fetch_secret() {",
    `  curl -s -H "Authorization: Bearer $TOKEN" "https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/$1/versions/latest:access" | grep -o '"data": *"[^"]*"' | cut -d'"' -f4 | base64 -d`,
    "}",
    "cat > /var/substrate/substrate.env <<EOF",
    `CADDY_IMAGE=${image}`,
    `SITE_DOMAIN=${siteDomain}`,
    `DIRECTUS_DOMAIN=${directusDomain}`,
    `OAUTH2_PROXY_GOOGLE_GROUP=${authGroup}`,
    `OAUTH2_PROXY_GOOGLE_ADMIN_EMAIL=${authAdminEmail}`,
    "GOOGLE_OAUTH_CLIENT_ID=$(fetch_secret google-oauth-client-id)",
    "GOOGLE_OAUTH_CLIENT_SECRET=$(fetch_secret google-oauth-client-secret)",
    // oauth2-proxy needs URL-safe base64; the stored secret may be standard base64 (same bytes).
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
    // A failed fetch_secret here doesn't trip `set -e` (it's inside a command substitution) - it
    // just leaves the value empty. Check explicitly rather than boot without credentials.
    "for key in GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET OAUTH2_PROXY_COOKIE_SECRET \\",
    "           DIRECTUS_KEY DIRECTUS_SECRET DIRECTUS_DB_PASSWORD DIRECTUS_ADMIN_PASSWORD; do",
    '  grep -q "^$key=.\\+" /var/substrate/substrate.env || { echo "$key is empty; secret fetch failed"; exit 1; }',
    "done",
    // COS's root filesystem is read-only, so docker's default config path (/root/.docker) isn't.
    "mkdir -p /var/substrate/.docker",
    "export DOCKER_CONFIG=/var/substrate/.docker",
    `docker login -u oauth2accesstoken -p "$TOKEN" https://${registryHost}`,
    // Removes other containers holding host port 80/443, not other compose projects wholesale
    // (#100/#107 - "not our label" would match every other legitimate app). `docker inspect`, not
    // `docker ps --filter publish=`, which isn't universally supported.
    "for cid in $(docker ps -aq); do",
    "  ports=$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{(index $b 0).HostPort}} {{end}}{{end}}' \"$cid\" 2>/dev/null || true)",
    '  case " $ports " in',
    '    *" 80 "*|*" 443 "*)',
    `      project=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$cid" 2>/dev/null || true)`,
    `      if [ "$project" != "${composeProjectName}" ]; then docker rm -f "$cid" || true; fi`,
    "      ;;",
    "  esac",
    "done",
    // COS has neither the compose plugin nor the standalone binary - fall back to docker:cli.
    "if docker compose version >/dev/null 2>&1; then DC='docker compose';",
    "elif command -v docker-compose >/dev/null 2>&1; then DC='docker-compose';",
    "else DC='docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v /var/substrate:/var/substrate -v /var/substrate/.docker:/root/.docker docker:cli compose'; fi",
    "$DC --project-directory /var/substrate --env-file /var/substrate/substrate.env -f /var/substrate/docker-compose.yml pull",
    "$DC --project-directory /var/substrate --env-file /var/substrate/substrate.env -f /var/substrate/docker-compose.yml up -d",
  ].join("\n");
}

/** `Type=oneshot`, no `RemainAfterExit`: goes back to `inactive` after each run, so `start` always
 * re-runs it rather than no-op'ing - and a concurrent `start` attaches to an in-flight run instead
 * of racing it. `WantedBy=multi-user.target` + `enable` re-runs it on a plain reboot too. */
export const substrateApplyUnit = [
  "[Unit]",
  "Description=Reconcile the substrate compose stack",
  "After=docker.service network-online.target",
  "Wants=network-online.target",
  "",
  "[Service]",
  "Type=oneshot",
  // Run through bash rather than exec'ing the file: COS mounts /var noexec, so a direct ExecStart
  // fails with 203/EXEC however the mode bits are set.
  "ExecStart=/bin/bash /var/substrate/apply.sh",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
].join("\n");

/** `--wait` blocks until apply.sh finishes or fails. Shared by both callers below. */
export const activateSubstrateApplyCommands: readonly string[] = [
  "systemctl daemon-reload",
  "systemctl enable substrate-apply.service",
  "systemctl start --wait substrate-apply.service",
];

export interface SubstrateFile {
  path: string;
  /** Octal permission string, e.g. `"0644"`. */
  permissions: string;
  content: string;
}

export interface CloudConfigParams extends BootstrapScriptParams {
  composeContent: string;
}

/** One manifest so `cloudConfig` and `remoteApplyPayload` can't drift from each other. */
export function substrateFiles(params: CloudConfigParams): SubstrateFile[] {
  return [
    { path: "/var/substrate/docker-compose.yml", permissions: "0644", content: params.composeContent },
    { path: "/var/substrate/apply.sh", permissions: "0755", content: bootstrapScript(params) },
    { path: "/etc/systemd/system/substrate-apply.service", permissions: "0644", content: substrateApplyUnit },
  ];
}

/** COS `user-data` - runs only on first boot (or after a replace), never on a running VM. */
export function cloudConfig(params: CloudConfigParams): string {
  const files = substrateFiles(params);
  return [
    "#cloud-config",
    "",
    "write_files:",
    ...files.flatMap((file) => [
      `  - path: ${file.path}`,
      `    permissions: "${file.permissions}"`,
      "    content: |",
      indent(file.content, 6),
    ]),
    "",
    "runcmd:",
    ...activateSubstrateApplyCommands.map(
      (command) =>
        `  - [${command
          .split(" ")
          .map((word) => `'${word}'`)
          .join(", ")}]`,
    ),
    "",
  ].join("\n");
}

/** Runs as root over an already-open IAP SSH session (substrate-apply.ts). Writes each file to a
 * `.new` path and `mv`s it into place so a concurrent cloud-init write can't land a half-written
 * file; heredocs are single-quoted so this shell doesn't expand apply.sh's own `$VAR`s. This lands
 * in Pulumi state, so it must never carry a secret value - apply.sh fetches those itself. */
export function remoteApplyPayload(params: CloudConfigParams): string {
  const files = substrateFiles(params);
  return [
    "set -euo pipefail",
    ...files.flatMap((file, index) => {
      const marker = `SUBSTRATE_FILE_${index}_EOF`;
      const tmp = `${file.path}.new`;
      return [
        `mkdir -p "$(dirname ${file.path})"`,
        `cat > ${tmp} <<'${marker}'`,
        file.content,
        marker,
        `chmod ${file.permissions} ${tmp}`,
        `mv ${tmp} ${file.path}`,
      ];
    }),
    ...activateSubstrateApplyCommands,
  ].join("\n");
}

export interface RemoteSshCommandParams {
  /** The real GCE instance name (auto-suffixed; may differ from the Pulumi logical name). */
  instanceName: string;
  zone: string;
  projectId: string;
}

/** Runs (wherever `pulumi up` runs) over IAP SSH, reusing deployers' existing
 * `iap.tunnelResourceAccessor`/`compute.osLogin` grants. Retries ~2 minutes - IAP/OS Login setup on
 * a new or replaced VM isn't instant - then pipes the payload (via `local.Command`'s `stdin`) into
 * `sudo bash -s`.
 *
 * Host-key checking is deliberately disabled, not set to "accept-new" (with no known-hosts file
 * that's the same thing, just less obvious): the IAP tunnel is already authenticated and encrypted
 * by Google, so pinning the host key adds little, and a VM replace's new key would otherwise break
 * every apply. */
export function remoteSshCommand(params: RemoteSshCommandParams): string {
  const { instanceName, zone, projectId } = params;
  const sshFlags = [
    `--project=${projectId}`,
    `--zone=${zone}`,
    "--tunnel-through-iap",
    "--quiet",
    // Double-quoted, not single: this array is joined into one shell command line below, so the
    // shell must see one quoted arg per flag, not `-o` and `k=v` split apart.
    '--ssh-flag="-o StrictHostKeyChecking=no"',
    '--ssh-flag="-o UserKnownHostsFile=/dev/null"',
  ].join(" ");
  return [
    "set -euo pipefail",
    "attempt=0",
    "until gcloud compute ssh " + `${instanceName} ${sshFlags} --command=true </dev/null >/dev/null 2>&1; do`,
    "  attempt=$((attempt + 1))",
    '  if [ "$attempt" -ge 24 ]; then',
    `    echo "substrate VM (${instanceName}) not reachable over IAP SSH after 2 minutes" >&2`,
    "    exit 1",
    "  fi",
    "  sleep 5",
    "done",
    `gcloud compute ssh ${instanceName} ${sshFlags} --command="sudo bash -s"`,
  ].join("\n");
}
