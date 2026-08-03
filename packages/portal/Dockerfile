# Bakes the pre-built static portal into a Caddy image. Caddy terminates TLS, gates every request
# through oauth2-proxy (see Caddyfile), and serves the static files on success.
#
# Build context is the repo root (see infrastructure/src/portal.ts), and the site is expected to be
# built already (`pnpm --filter @cyc-seattle/portal build`) so `dist/site` exists.
FROM caddy:2-alpine

COPY packages/portal/deploy/Caddyfile /etc/caddy/Caddyfile
COPY packages/portal/dist/site /srv

EXPOSE 80 443
