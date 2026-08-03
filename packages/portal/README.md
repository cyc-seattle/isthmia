# @cyc-seattle/portal

The `cycsail.team` link portal: a **purely static site** (no backend) that gives staff, volunteers,
and instructors one bookmark for the tools they use. It doubles as the platform's **Google-auth
proof-of-concept** — the same Caddy + oauth2-proxy pattern that will later front apps like FreeScout.

## How it works

- **Content:** `src/links.ts` is the single source of truth — a typed, audience-grouped list of
  links. `pnpm --filter @cyc-seattle/portal build` renders it to `dist/site/index.html`.
- **Serving + auth:** Caddy (this package's `Dockerfile`) serves the static files and gates every
  request through **oauth2-proxy** (Google). oauth2-proxy accepts **any Google account** but is
  restricted to members of **`all@cyccommunitysailing.org`** (which nests `staff@`, `volunteers@`,
  …). Reaching the site at all _is_ the access check — there is no per-page logic. Volunteers on
  personal Google accounts get in by being group members.
- **Where it runs:** the substrate VM, as a two-container compose stack defined by
  `deploy/docker-compose.yml` and `deploy/Caddyfile`. The VM boots it via cloud-init — see
  `infrastructure/src/portal-bootstrap.ts`.

## What Pulumi manages (`infrastructure/src/portal.ts` + `portal-bootstrap.ts`)

- The Caddy image (static site baked in) in Artifact Registry.
- Secret Manager secrets `portal-oauth-client-id`, `portal-oauth-client-secret`,
  `portal-oauth-cookie-secret` (declared here; values set out of band).
- The substrate VM's `user-data` cloud-init, which fetches those secrets at boot and runs the
  compose stack.
- An `A` record for `cycsail.team` → the substrate VM's static IP.

So a `just deploy` builds/pushes the image and (re)configures the VM. **Because cloud-init only runs
on first boot, an already-running VM must be reset (or the bootstrap re-run by hand) to pick up a
new stack.**

## One-time manual prerequisites

The portal needs a few out-of-band steps (OAuth client + External consent screen, domain-wide
delegation, the `all@` group, and DNS delegation) before it serves. These can't be
infrastructure-as-code, so they live in the repo-wide record: **[docs/manual-setup.md](../../docs/manual-setup.md) → §4 (DNS) and §5 (Portal Google auth)**.

## Config knobs (Pulumi)

- `infrastructure:portalAuthGroup` (default `all@cyccommunitysailing.org`)
- `infrastructure:portalAuthAdminEmail` (default `master@cyccommunitysailing.org`)
