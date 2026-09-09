# The substrate VM's single public listener: Caddy, terminating TLS for every surface (see
# deploy/Caddyfile) — gating cycsail.team through oauth2-proxy and serving the portal's static
# files, and reverse-proxying crm.* straight to Directus. Bakes in the portal's static site since
# Caddy needs it on disk; the portal package itself only builds that output, nothing more.
#
# Build context is the repo root (see infrastructure/src/substrate.ts), and the portal's site is
# expected to be built already (`pnpm --filter @cyc-seattle/portal build`) so `dist/site` exists.
FROM caddy:2-alpine

COPY packages/substrate/deploy/Caddyfile /etc/caddy/Caddyfile
COPY packages/portal/dist/site /srv

EXPOSE 80 443
