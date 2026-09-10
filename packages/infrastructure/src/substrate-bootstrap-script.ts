// Pure string-templating for the substrate VM's bootstrap/reconcile logic — deliberately free of
// any `@pulumi/*` import so it can be unit tested with plain function calls. Two Pulumi-touching
// callers resolve real `pulumi.Output` values and call into here:
//   - substrate-bootstrap.ts: cloud-init `user-data`, which COS only runs on a VM's *first* boot.
//   - substrate-apply.ts: a Pulumi `local.Command` that re-applies the same files over IAP SSH on
//     every `pulumi up`, so a compose/image change reconciles a VM that's already running (see #107).
// Both write the exact same three files (`substrateFiles`, below) and start the same systemd unit;
// cloud-init is what gets a freshly-created or replaced VM to a working state unattended, and the
// remote-exec path is what makes an *existing* VM pick up a change without being replaced.

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
  /** Matches `docker compose`'s default project-naming (basename of `--project-directory`, below) —
   * needed by the container-cleanup step too. */
  composeProjectName: string;
}

// `/var/substrate/apply.sh`'s content — idempotent and safe to re-run: it always re-fetches
// secrets, rewrites the env file, and reconciles the compose stack, so running it twice in a row
// (or a hundred times) converges on the same state rather than accumulating drift. `$VAR` / `$(...)`
// are shell (no `${` so template literals leave them alone); the interpolated `${...}` values are
// plain build-time strings.
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
    // The optional space after the colon matters: Secret Manager pretty-prints its JSON responses
    // (unlike the metadata server's compact token JSON above).
    "fetch_secret() {",
    `  curl -s -H "Authorization: Bearer $TOKEN" "https://secretmanager.googleapis.com/v1/projects/${projectId}/secrets/$1/versions/latest:access" | grep -o '"data": *"[^"]*"' | cut -d'"' -f4 | base64 -d`,
    "}",
    "cat > /var/substrate/substrate.env <<EOF",
    `CADDY_IMAGE=${image}`,
    `SITE_DOMAIN=${siteDomain}`,
    `DIRECTUS_DOMAIN=${directusDomain}`,
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
    // Tear down any *other* container holding host port 80 or 443 before bringing this project's
    // own caddy up — that's the only port this project needs exclusively, and the only thing a
    // leftover/foreign stack can do to break it (see #99: the pre-rename `portal` project never got
    // torn down and kept holding these ports, so this project's own caddy failed to bind them,
    // plausibly interrupting Directus mid-bootstrap). Narrowed from "any container not labeled
    // ${composeProjectName}" (#100) to this port-scoped rule (#107) because under one-compose-
    // project-per-app, every legitimate app is "not labeled ${composeProjectName}" — the old rule
    // would delete all of them. Uses `docker inspect`'s Go-template output rather than
    // `docker ps --filter publish=`, which isn't implemented by every docker-compatible CLI
    // (verified: podman's docker shim rejects the `publish` filter outright) — inspecting
    // `.NetworkSettings.Ports` directly is standard `docker inspect` output on any Docker Engine.
    "for cid in $(docker ps -aq); do",
    "  ports=$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{(index $b 0).HostPort}} {{end}}{{end}}' \"$cid\" 2>/dev/null || true)",
    '  case " $ports " in',
    '    *" 80 "*|*" 443 "*)',
    `      project=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project" }}' "$cid" 2>/dev/null || true)`,
    `      if [ "$project" != "${composeProjectName}" ]; then docker rm -f "$cid" || true; fi`,
    "      ;;",
    "  esac",
    "done",
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

/** The systemd unit that makes `apply.sh` a stable, named, idempotently-re-runnable entry point —
 * `systemctl start substrate-apply` reconciles the compose stack whether it's triggered by
 * cloud-init (first boot), Pulumi's remote-exec (`substrate-apply.ts`, every `pulumi up`), or a
 * human SSHed in for a one-off look. `Type=oneshot` with no `RemainAfterExit` means the unit goes
 * back to `inactive` as soon as `apply.sh` exits, so a later `systemctl start` always re-runs it
 * rather than being a no-op against a "succeeded" unit — re-runnability comes from that, combined
 * with `apply.sh`'s own idempotence. Concurrent `start`s of a unit already mid-run are what systemd
 * itself serializes (a second `start` attaches to the in-flight job instead of running a second
 * instance) — that, not "already succeeded", is what makes overlapping triggers (e.g. cloud-init's
 * first-boot run racing an immediate `pulumi up`) safe. `WantedBy=multi-user.target` plus `enable`
 * (below) means a plain reboot also re-runs it, so a VM that's rebooted (not replaced) reconciles
 * itself too, not just a freshly created/replaced one. */
export const substrateApplyUnit = [
  "[Unit]",
  "Description=Reconcile the substrate compose stack",
  "After=docker.service network-online.target",
  "Wants=network-online.target",
  "",
  "[Service]",
  "Type=oneshot",
  "ExecStart=/var/substrate/apply.sh",
  "",
  "[Install]",
  "WantedBy=multi-user.target",
  "",
].join("\n");

/** `--wait` makes `start` block until the unit's job (i.e. `apply.sh` itself) finishes, succeeding
 * or failing with it — needed so both cloud-init's `runcmd` and Pulumi's remote-exec actually wait
 * for the compose stack to reconcile (and surface a failure) rather than firing-and-forgetting a
 * background job. Run identically by both callers so there's exactly one "activate" sequence to
 * reason about. */
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

/** The three files that fully describe the substrate VM's compose stack + its reconcile
 * entrypoint — written identically by cloud-init (first boot) and by Pulumi's remote-exec (every
 * subsequent `pulumi up`; see substrate-apply.ts). Kept as one manifest so the two renderers below
 * (`cloudConfig`, `remoteApplyPayload`) can't drift from each other. */
export function substrateFiles(params: CloudConfigParams): SubstrateFile[] {
  return [
    { path: "/var/substrate/docker-compose.yml", permissions: "0644", content: params.composeContent },
    { path: "/var/substrate/apply.sh", permissions: "0755", content: bootstrapScript(params) },
    { path: "/etc/systemd/system/substrate-apply.service", permissions: "0644", content: substrateApplyUnit },
  ];
}

/** COS `user-data`: cloud-init only ever runs this on a VM's *first* boot (or after a replace) —
 * see compute.ts. It writes the files known at VM-create time and starts the systemd unit so a
 * freshly created (or replaced) VM comes up fully self-hosting with no `pulumi up` remote-exec step
 * required; `substrate-apply.ts`'s Pulumi resource is what keeps an already-running VM in sync
 * with a *later* compose/image change, which cloud-init structurally cannot do (COS never re-runs
 * it on a running VM). */
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

/** The script Pulumi's remote-exec resource (`substrate-apply.ts`) runs, as root, over an IAP SSH
 * session already established to the substrate VM — the "update" counterpart to `cloudConfig`'s
 * "first boot" (see the file-level comment). Writes each file to a `.new` path first and `mv`s it
 * into place, so a write is atomic from any concurrent reader's point of view (in particular: this
 * running at the same moment as cloud-init's own first-boot write, immediately after a VM replace,
 * can't leave a half-written file for either side to read) — and heredocs are all single-quoted
 * (`<<'...'`) so this outer shell never expands anything inside the file contents themselves, even
 * though those contents legitimately contain `$VAR` shell references meant for `apply.sh`'s own
 * later execution. Carries no secret values — only the compose file, `apply.sh`'s script text (which
 * fetches secrets itself, at run time, directly from Secret Manager), and the unit file, none of
 * which contain credentials — so nothing here needs to avoid Pulumi state recording it. */
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
  /** The real GCE instance name (its Pulumi resource may auto-suffix this — always resolve the
   * actual `instance.name` output, never assume it matches the logical Pulumi resource name). */
  instanceName: string;
  zone: string;
  projectId: string;
}

/** The command Pulumi's `local.Command` runs locally (i.e. wherever `pulumi up` runs) to apply a
 * payload to the substrate VM over IAP-tunneled SSH — reusing the `roles/iap.tunnelResourceAccessor`
 * + `roles/compute.osLogin` grants deployers already hold (`compute.ts`), the same mechanism used
 * by hand today, rather than standing up separate SSH-key machinery (rejected for #99, for good
 * reason). Retries the connection itself for ~2 minutes before giving up — OS Login key
 * propagation / IAP tunnel setup on a brand-new or just-replaced VM isn't instant, the same
 * reasoning as `waitForReachable`'s retry loop, just for SSH instead of HTTP — then pipes the
 * caller-supplied payload (via the `local.Command`'s own `stdin`, not embedded in this command
 * string) into `sudo bash -s` on the VM.
 *
 * `-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`: a *replaced* VM reuses the same
 * static IP (`compute.ts`) but gets a new host key, which would otherwise block this non-interactive
 * path on a host-key-changed prompt. Accepted here because IAP tunneling — not the SSH host key —
 * is the actual security boundary for this channel (Google authenticates and encrypts the tunnel
 * itself); flagging this explicitly since it's a real trade-off, not an oversight.
 */
export function remoteSshCommand(params: RemoteSshCommandParams): string {
  const { instanceName, zone, projectId } = params;
  const sshFlags = [
    `--project=${projectId}`,
    `--zone=${zone}`,
    "--tunnel-through-iap",
    "--quiet",
    // Double-quoted (not single) because this whole array is `.join(" ")`-ed into one shell
    // command line below — the quotes here are what the shell sees, keeping each `-o ...=...`
    // pair as a single argument to `--ssh-flag` rather than splitting on its internal space.
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
