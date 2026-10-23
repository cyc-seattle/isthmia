# @cyc-seattle/portal

The `cycsail.team` link portal: a **purely static site** (no backend) that gives staff, volunteers,
instructors, and families one bookmark for the tools they use. Gated by Authentik's forward-auth
outpost (#166).

## How it works

- **Content:** `src/links.ts` is the single source of truth — a typed, audience-grouped list of
  links. Each section may set `staffOnly`, restricting it to a visitor in Authentik's `staff` group.
- **Rendering:** `render.ts` renders the page as a Caddy template — a `staffOnly` section is wrapped
  in an `{{if has "staff" $groups}}` condition on the `X-Authentik-Groups` header Authentik's
  outpost sets, so a link for a group the visitor isn't in never reaches the served HTML.
  `pnpm --filter @cyc-seattle/portal build` writes the result to `dist/site/index.html`.
- **Serving + auth:** the `Dockerfile` bakes the built site into a Caddy image. Its `Caddyfile`
  gates the site with `forward_auth` against Authentik's embedded outpost, and serves it through
  Caddy's `templates` handler so the `{{if}}` conditions actually evaluate.
- **Roster (#166):** `src/roster/` is the one dynamic section, calling `directus.<host>` client-side
  with `credentials: "include"` — Directus's own permission rules decide what each viewer sees, so
  there's still no portal backend. It's compiled separately, by `tsconfig.client.json` (DOM lib, no
  bundler), to `dist/site/roster/*.js`; `model.ts` and `render.ts` are pure and covered by
  `test/roster-*.test.ts`, `browser.ts` is the thin fetch-and-mount glue.
- **Where it runs:** the GKE cluster, in each environment's namespace.

## What Pulumi manages (`infrastructure/src/portal/`)

- The image, built in dev and run by digest in prod, and its `WebService`.
- In prod, an `A` record for `cycsail.team` → the Gateway's address.

Authentik's own
configuration (the forward-auth provider, the `staff` group) is `packages/infrastructure/src/authentik`'s
concern; `staff` membership itself is assigned by hand in Authentik, not synced from anywhere.

## One-time manual prerequisites

DNS delegation is the one out-of-band step this package still needs — see
**[docs/manual-setup.md](../../docs/manual-setup.md) → §4**. Authentik's own prerequisites are
listed there too, under §8.
