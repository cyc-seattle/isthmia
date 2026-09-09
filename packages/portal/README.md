# @cyc-seattle/portal

The `cycsail.team` link portal: a **purely static site** (no backend) that gives staff, volunteers,
and instructors one bookmark for the tools they use. It doubles as the platform's **Google-auth
proof-of-concept** — the same Caddy + oauth2-proxy pattern that fronts other apps on the substrate.

## How it works

- **Content:** `src/links.ts` is the single source of truth — a typed, audience-grouped list of
  links. `pnpm --filter @cyc-seattle/portal build` renders it to `dist/site/index.html`.
- **Serving + auth:** this package only builds that static output — it doesn't own a Dockerfile or
  a compose stack. `@cyc-seattle/substrate` bakes the built site into its shared Caddy image and
  serves it there, gated by oauth2-proxy (restricted to `all@cyccommunitysailing.org`, which nests
  `staff@`, `volunteers@`, …). Reaching the site at all _is_ the access check — there is no
  per-page logic.
- **Where it runs:** the substrate VM — see `@cyc-seattle/substrate`'s README.

## What Pulumi manages (`infrastructure/src/portal.ts`)

- Secret Manager secret `portal-oauth-cookie-secret` (declared here; value set out of band).
  The Google OAuth client itself is shared platform-wide — see `@cyc-seattle/substrate`.
- An `A` record for `cycsail.team` → the substrate VM's static IP.

The Caddy image build, the VM's cloud-init, and the compose stack itself are
`@cyc-seattle/substrate`'s concern (`infrastructure/src/substrate.ts` +
`substrate-bootstrap.ts`) — this package only has to produce `dist/site`.

## One-time manual prerequisites

The portal needs a few out-of-band steps (OAuth client + External consent screen, domain-wide
delegation, the `all@` group, and DNS delegation) before it serves. These can't be
infrastructure-as-code, so they live in the repo-wide record: **[docs/manual-setup.md](../../docs/manual-setup.md) → §4 (DNS) and §5 (Shared Google auth)**.

## Config knobs (Pulumi)

- `infrastructure:portalAuthGroup` (default `all@cyccommunitysailing.org`)
- `infrastructure:portalAuthAdminEmail` (default `master@cyccommunitysailing.org`)
