# @cyc-seattle/substrate

The substrate VM's shared front door: one Caddy container terminating TLS for every surface that
runs on it, routed by hostname. Not an app itself — this is the infrastructure apps sit behind.

## How it works

- **`Dockerfile`** bakes Caddy plus whichever static content it needs to serve directly (today,
  the portal's built site — see `@cyc-seattle/portal`).
- **`deploy/Caddyfile`** is the routing config: `cycsail.team` gated by oauth2-proxy (Google,
  restricted to the `all@` group), `directus.*` reverse-proxied straight to Directus (which handles its
  own login).
- **`deploy/docker-compose.yml`** is the whole VM's compose stack — Caddy, oauth2-proxy, Directus,
  and whatever else lands on this VM next.
- **Where it runs:** as `/var/substrate/apply.sh`, installed as the `substrate-apply.service`
  systemd unit (`systemctl start substrate-apply` reconciles it by hand if you're ever SSHed in) —
  see `infrastructure/src/substrate-bootstrap-script.ts`.

## What Pulumi manages

- `infrastructure/src/substrate.ts` — the Caddy image (Artifact Registry) and the IAM the VM needs
  to pull it.
- `infrastructure/src/substrate-bootstrap-script.ts` — the pure templating for `apply.sh`, the
  compose file, and the systemd unit (unit-tested; no `@pulumi/*` import).
- `infrastructure/src/substrate-bootstrap.ts` — COS `user-data` cloud-init, which writes those same
  files and starts the unit, but **only ever runs on a VM's first boot** (or after a replace).
- `infrastructure/src/substrate-apply.ts` — a Pulumi `local.Command` that re-applies the same files
  to the VM over IAP-tunneled SSH on every `pulumi up` (triggered by a compose-content hash or an
  image-tag change), so an _already-running_ VM picks up the change too — this is what makes
  editing `deploy/docker-compose.yml` or bumping the image a normal `pulumi up`, with no VM replace
  and no manual SSH (#107).
- Per-app files (`portal.ts`, `directus.ts`, …) declare that app's own secrets/DNS/database and
  plug into this shared stack, and depend on `substrate-apply.ts`'s resource so they don't race VM
  boot.
