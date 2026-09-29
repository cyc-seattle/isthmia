# @cyc-seattle/portal

The `cycsail.team` link portal: a **purely static site** (no backend) that gives staff, volunteers,
instructors, and families one bookmark for the tools they use. Gated by Authentik's forward-auth
outpost (#166), the same one that fronts every other app on the substrate.

## How it works

- **Content:** `src/links.ts` is the single source of truth — a typed, audience-grouped list of
  links. Each section may set `staffOnly`, restricting it to a visitor in Authentik's `staff` group.
- **Rendering:** `render.ts` renders the page as a Caddy template — a `staffOnly` section is wrapped
  in an `{{if has "staff" $groups}}` condition on the `X-Authentik-Groups` header Authentik's
  outpost sets, so a link for a group the visitor isn't in never reaches the served HTML.
  `pnpm --filter @cyc-seattle/portal build` writes the result to `dist/site/index.html`.
- **Serving + auth:** this package only builds that static output — it doesn't own a Dockerfile or
  a compose stack. `@cyc-seattle/substrate` bakes the built site into its shared Caddy image, gates
  it with `forward_auth` against Authentik's embedded outpost, and serves it through Caddy's
  `templates` handler so the `{{if}}` conditions actually evaluate.
- **Where it runs:** the substrate VM — see `@cyc-seattle/substrate`'s README.

## What Pulumi manages (`infrastructure/src/portal.ts`)

- An `A` record for `cycsail.team` → the substrate VM's static IP.

The Caddy image build, the VM's cloud-init, and the compose stack itself are
`@cyc-seattle/substrate`'s concern (`infrastructure/src/substrate.ts` +
`substrate-bootstrap.ts`) — this package only has to produce `dist/site`. Authentik's own
configuration (the forward-auth provider, the `staff` group) is `packages/infrastructure/src/authentik`'s
concern; `staff` membership itself is assigned by hand in Authentik, not synced from anywhere.

## One-time manual prerequisites

DNS delegation is the one out-of-band step this package still needs — see
**[docs/manual-setup.md](../../docs/manual-setup.md) → §4**. Authentik's own prerequisites are
listed there too, under §8.
