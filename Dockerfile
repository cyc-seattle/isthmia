FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && npm install -g corepack@latest

# Runs on the build host's own architecture (arm64 on Apple Silicon) instead of under emulation,
# even though clubspot-sync/gsuite-sync below stay linux/amd64 (#129). tsc's output is
# architecture-neutral and the production dependency trees are pure JS, so a cross-arch build here
# is safe.
FROM --platform=$BUILDPLATFORM base AS build
WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./

# pnpm reads every workspace member named in the lockfile, so each one needs a manifest here even
# though most packages' source never enters this stage (#114).
COPY packages/clubspot/package.json packages/clubspot/
COPY packages/clubspot-sync/package.json packages/clubspot-sync/
COPY packages/crm/package.json packages/crm/
COPY packages/directus/package.json packages/directus/
COPY packages/gsuite-sync/package.json packages/gsuite-sync/
COPY packages/infrastructure/package.json packages/infrastructure/
COPY packages/portal/package.json packages/portal/

# --ignore-scripts throughout this stage: install only resolves and links node_modules, never
# running a package's `prepare` (tsc --build). That keeps this layer cached across source-only
# changes.
#
# Building happens explicitly below, in two dependency tiers, with a `pnpm install --offline`
# between each to refresh node_modules. That refresh is required, not cosmetic:
# inject-workspace-packages (.npmrc) hard-copies a workspace dependency's `files` into its
# consumer's node_modules at link time, so a consumer built before its dependency would still see
# the dependency's pre-build (missing dist) copy.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter=@cyc-seattle/clubspot-sync... --filter=@cyc-seattle/gsuite-sync...

COPY packages/clubspot/ packages/clubspot/
COPY packages/crm/ packages/crm/
COPY packages/directus/ packages/directus/
RUN pnpm --filter=@cyc-seattle/clubspot --filter=@cyc-seattle/crm --filter=@cyc-seattle/directus run build
RUN pnpm install --frozen-lockfile --ignore-scripts --offline --filter=@cyc-seattle/clubspot-sync... --filter=@cyc-seattle/gsuite-sync...

COPY packages/clubspot-sync/ packages/clubspot-sync/
COPY packages/gsuite-sync/ packages/gsuite-sync/
RUN pnpm --filter=@cyc-seattle/clubspot-sync --filter=@cyc-seattle/gsuite-sync run build

RUN pnpm deploy --ignore-scripts --filter=clubspot-sync --prod /usr/app/clubspot-sync
RUN pnpm deploy --ignore-scripts --filter=gsuite-sync --prod /usr/app/gsuite-sync

FROM base AS clubspot-sync
COPY --from=build --chown=node:node /usr/app/clubspot-sync /usr/app/clubspot-sync
WORKDIR /usr/app/clubspot-sync
# Numeric, so Kubernetes' runAsNonRoot can verify it. 1000 is the base image's `node`.
USER 1000:1000
ENV NODE_ENV=production
CMD ["node", "./dist/main.js", "--logging", "json"]

FROM base AS gsuite-sync
COPY --from=build --chown=node:node /usr/app/gsuite-sync /usr/app/gsuite-sync
WORKDIR /usr/app/gsuite-sync
USER 1000:1000
ENV NODE_ENV=production
CMD ["node", "./dist/main.js", "--logging", "json"]
