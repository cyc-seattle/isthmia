# @cyc-seattle/substrate

The substrate VM's shared front door: one Caddy container terminating TLS for every surface that
runs on it, routed by hostname. Not an app itself — this is the infrastructure apps sit behind.

## How it works

- **`Dockerfile`** bakes Caddy plus whichever static content it needs to serve directly (today,
  the portal's built site — see `@cyc-seattle/portal`).
- **`deploy/Caddyfile`** is the routing config: `cycsail.team` gated by oauth2-proxy (Google,
  restricted to the `all@` group), `crm.*` reverse-proxied straight to Directus (which handles its
  own login).
- **`deploy/docker-compose.yml`** is the whole VM's compose stack — Caddy, oauth2-proxy, Directus,
  and whatever else lands on this VM next.
- **Where it runs:** the substrate VM boots this stack via cloud-init — see
  `infrastructure/src/substrate-bootstrap.ts`.

## What Pulumi manages

- `infrastructure/src/substrate.ts` — the Caddy image (Artifact Registry) and the IAM the VM needs
  to pull it.
- `infrastructure/src/substrate-bootstrap.ts` — the VM's `user-data` cloud-init: fetches every
  app's secrets from Secret Manager at boot and runs the compose stack.
- Per-app files (`portal.ts`, `directus.ts`, …) declare that app's own secrets/DNS/database and
  plug into this shared stack.

**Because cloud-init only runs on first boot, an already-running VM must be reset (or the bootstrap
re-run by hand) to pick up a new stack.**
