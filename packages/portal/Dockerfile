# Bakes the pre-built static portal into a Caddy image. Caddy is the substrate VM's single public
# listener, terminating TLS for every surface (see Caddyfile) — gating cycsail.team through
# oauth2-proxy and serving its static files, and reverse-proxying crm.* straight to Directus.
#
# Build context is the repo root (see infrastructure/src/portal.ts), and the site is expected to be
# built already (`pnpm --filter @cyc-seattle/portal build`) so `dist/site` exists.
FROM caddy:2-alpine

COPY packages/portal/deploy/Caddyfile /etc/caddy/Caddyfile
COPY packages/portal/dist/site /srv

EXPOSE 80 443
