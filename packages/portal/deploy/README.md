# cycsail.team portal — deployment

The portal is a **purely static site** (`packages/portal`) served by **Caddy** on the substrate VM,
gated by **oauth2-proxy** (Google) restricted to the **`all@cyccommunitysailing.org`** group. There
is no application backend: authenticating _and_ being a member of `all@` (which nests `staff@`,
`volunteers@`, …) is the only access check. Personal Google accounts work — a volunteer just has to
be a member of one of those groups.

## What Pulumi manages (`infrastructure/src/portal.ts`)

- The Caddy image (static site baked in) in Artifact Registry.
- Secret Manager secrets `portal-oauth-client-id`, `portal-oauth-client-secret`,
  `portal-oauth-cookie-secret` (declared; values set out of band).
- An `A` record for `cycsail.team` → the substrate VM's static IP.

## One-time manual prerequisites (not automatable / done in consoles)

1. **OAuth 2.0 Client ID** in the `cyc-admin-scripts` project:
   - Consent screen **External** (so personal Google accounts can sign in).
   - Authorized redirect URI: `https://cycsail.team/oauth2/callback`.
   - Put the client id/secret into the two secrets above; generate a cookie secret
     (`openssl rand -base64 32`) into the third.
2. **Domain-wide delegation** so oauth2-proxy can read Google Group membership via the Directory API
   using the VM's service account (no key file — it uses ADC from the metadata server):
   - In the Workspace Admin console → Security → API controls → Domain-wide delegation, authorize the
     **substrate-runner** service account's client ID for scope
     `https://www.googleapis.com/auth/admin.directory.group.readonly`.
   - `--google-admin-email` must be a Workspace admin the SA impersonates (e.g. `master@…`).
   - ⚠️ **Verify nested-group resolution:** confirm a member of `staff@` (nested under `all@`) is
     admitted. If oauth2-proxy only honors direct membership, list the subgroups explicitly instead.
3. **`all@` group** already exists; ensure the intended subgroups/members (incl. a test personal
   Gmail) are in it.
4. **Registrar delegation:** delegate `cycsail.team` to the managed zone's name servers
   (`pulumi stack output nameServers`). DNS and the ACME cert stay inert until this is done — test
   via the VM IP + a `hosts` entry first.

## Bringing the compose stack up on the VM

> Not yet wired into the VM's cloud-init — this is the live cutover step, to be validated on the VM
> (COS container-run specifics can't be exercised in CI). Once validated, fold it into the VM's
> cloud-init in `infrastructure/src/compute.ts`.

On the substrate VM (reached over IAP SSH), with `docker-compose.yml` from this directory and an
env file assembled from the secrets above:

```sh
# env file (from Secret Manager) provides: PORTAL_IMAGE, SITE_DOMAIN, OAUTH2_PROXY_GOOGLE_GROUP,
# OAUTH2_PROXY_GOOGLE_ADMIN_EMAIL, OAUTH2_PROXY_CLIENT_ID/SECRET, OAUTH2_PROXY_COOKIE_SECRET
docker compose --env-file portal.env up -d
```

`SITE_DOMAIN=cycsail.team`, `OAUTH2_PROXY_GOOGLE_GROUP=all@cyccommunitysailing.org`.
