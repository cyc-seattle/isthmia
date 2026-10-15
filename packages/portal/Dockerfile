# The portal on the cluster (#231): Caddy and the built site, run non-root on a read-only root. The
# build context is the repo root (packages/infrastructure/src/portal).

# Runs on the build host's own architecture (#129); the site is architecture-neutral.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && npm install -g corepack@latest
WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./

# pnpm reads every workspace member named in the lockfile (#114).
COPY packages/clubspot/package.json packages/clubspot/
COPY packages/clubspot-sync/package.json packages/clubspot-sync/
COPY packages/crm/package.json packages/crm/
COPY packages/directus/package.json packages/directus/
COPY packages/gsuite-sync/package.json packages/gsuite-sync/
COPY packages/infrastructure/package.json packages/infrastructure/
COPY packages/portal/package.json packages/portal/
COPY packages/substrate/package.json packages/substrate/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter=@cyc-seattle/portal

COPY packages/portal/ packages/portal/
RUN pnpm --filter=@cyc-seattle/portal run build

FROM caddy:2-alpine

# Without capabilities, the kernel refuses to run a binary that carries file capabilities.
RUN apk add --no-cache libcap && setcap -r /usr/bin/caddy && apk del libcap

COPY packages/portal/Caddyfile /etc/caddy/Caddyfile
RUN caddy validate --adapter caddyfile --config /etc/caddy/Caddyfile
COPY --from=build /usr/src/app/packages/portal/dist/site /srv

# The pod mounts emptyDirs at XDG_DATA_HOME (/data) and XDG_CONFIG_HOME (/config).
USER 65532:65532
EXPOSE 8080
