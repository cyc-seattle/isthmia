# The substrate VM's single public listener: Caddy, terminating TLS for every surface (see
# deploy/Caddyfile) — gating cycsail.team through oauth2-proxy and serving the portal's static
# files, and reverse-proxying crm.* straight to Directus. The build stage compiles the portal's
# static site itself, so the image is derivable from its build context alone.
#
# Build context is the repo root (see infrastructure/src/substrate.ts).

# Runs on the build host's own architecture rather than under emulation for the final linux/amd64
# image (#129); tsc's output is architecture-neutral and the portal has no native dependencies.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && npm install -g corepack@latest
WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./

# pnpm reads every workspace member named in the lockfile, so each one needs a manifest here even
# though only the portal's source enters this stage (#114).
COPY packages/admin-functions/package.json packages/admin-functions/
COPY packages/calendar-sync/package.json packages/calendar-sync/
COPY packages/clubspot-sdk/package.json packages/clubspot-sdk/
COPY packages/clubspot-sync/package.json packages/clubspot-sync/
COPY packages/commodore/package.json packages/commodore/
COPY packages/crm/package.json packages/crm/
COPY packages/gsuite/package.json packages/gsuite/
COPY packages/infrastructure/package.json packages/infrastructure/
COPY packages/portal/package.json packages/portal/
COPY packages/substrate/package.json packages/substrate/
COPY packages/todo-manager/package.json packages/todo-manager/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter=@cyc-seattle/portal

COPY packages/portal/ packages/portal/
RUN pnpm --filter=@cyc-seattle/portal run build

FROM caddy:2-alpine

COPY packages/substrate/deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /usr/src/app/packages/portal/dist/site /srv

EXPOSE 80 443
