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

These can't be automated (they live in Google consoles / the registrar) and are required before the
site actually serves:

1. **OAuth 2.0 Client ID** in the `cyc-admin-scripts` project:
   - Consent screen **External** (so personal Google accounts can sign in).
   - Authorized redirect URI: `https://cycsail.team/oauth2/callback`.
   - Put the client id/secret into the two secrets above; generate a cookie secret
     (`openssl rand -base64 32`) into the third.
2. **Domain-wide delegation** so oauth2-proxy can read Google Group membership via the Directory API
   using the VM's service account (ADC from the metadata server — no key file):
   - In Workspace Admin → Security → API controls → Domain-wide delegation, authorize the
     **substrate-runner** service account's client ID for scope
     `https://www.googleapis.com/auth/admin.directory.group.readonly`.
   - The impersonated admin is `portalAuthAdminEmail` (default `master@…`).
   - ⚠️ **Verify nested-group resolution:** confirm a member of `staff@` (nested under `all@`) is
     admitted. If oauth2-proxy only honors direct membership, list the subgroups explicitly instead.
3. **`all@` group** already exists; ensure the intended subgroups/members (incl. a test personal
   Gmail) are in it.
4. **Registrar delegation:** delegate `cycsail.team` to the managed zone's name servers
   (`pulumi stack output nameServers`). DNS and the ACME cert stay inert until this is done.

## Config knobs (Pulumi)

- `infrastructure:portalAuthGroup` (default `all@cyccommunitysailing.org`)
- `infrastructure:portalAuthAdminEmail` (default `master@cyccommunitysailing.org`)
