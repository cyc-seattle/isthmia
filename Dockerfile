FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && npm install -g corepack@latest

# Runs on the build host's own architecture (arm64 on Apple Silicon) instead of under emulation,
# even though report-runner/clubspot-sync below stay linux/amd64 (#129). tsc's output is
# architecture-neutral and the production dependency trees are pure JS, so a cross-arch build here
# is safe.
FROM --platform=$BUILDPLATFORM base AS build
WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./

# pnpm reads every workspace member named in the lockfile, so each one needs a manifest here even
# though most packages' source never enters this stage (#114).
COPY packages/admin-functions/package.json packages/admin-functions/
COPY packages/calendar-sync/package.json packages/calendar-sync/
COPY packages/clubspot/package.json packages/clubspot/
COPY packages/clubspot-sdk/package.json packages/clubspot-sdk/
COPY packages/clubspot-sync/package.json packages/clubspot-sync/
COPY packages/commodore/package.json packages/commodore/
COPY packages/crm/package.json packages/crm/
COPY packages/directus/package.json packages/directus/
COPY packages/gsuite/package.json packages/gsuite/
COPY packages/gsuite-sync/package.json packages/gsuite-sync/
COPY packages/infrastructure/package.json packages/infrastructure/
COPY packages/portal/package.json packages/portal/
COPY packages/substrate/package.json packages/substrate/
COPY packages/todo-manager/package.json packages/todo-manager/

# --ignore-scripts throughout this stage: install only resolves and links node_modules, never
# running a package's `prepare` (tsc --build). That keeps this layer cached across source-only
# changes and, as a side effect, never touches calendar-sync or todo-manager, which used to
# recompile on every build despite never entering the image.
#
# Building happens explicitly below, in three dependency tiers, with a `pnpm install --offline`
# between each to refresh node_modules. That refresh is required, not cosmetic:
# inject-workspace-packages (.npmrc) hard-copies a workspace dependency's `files` into its
# consumer's node_modules at link time, so a consumer built before its dependency would still see
# the dependency's pre-build (missing dist) copy.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter=@cyc-seattle/admin-functions... --filter=@cyc-seattle/clubspot-sync... --filter=@cyc-seattle/gsuite-sync...

COPY packages/clubspot/ packages/clubspot/
COPY packages/commodore/ packages/commodore/
COPY packages/crm/ packages/crm/
COPY packages/directus/ packages/directus/
COPY packages/gsuite/ packages/gsuite/
RUN pnpm --filter=@cyc-seattle/clubspot --filter=@cyc-seattle/commodore --filter=@cyc-seattle/crm --filter=@cyc-seattle/directus --filter=@cyc-seattle/gsuite run build
RUN pnpm install --frozen-lockfile --ignore-scripts --offline --filter=@cyc-seattle/admin-functions... --filter=@cyc-seattle/clubspot-sync... --filter=@cyc-seattle/gsuite-sync...

COPY packages/clubspot-sdk/ packages/clubspot-sdk/
RUN pnpm --filter=@cyc-seattle/clubspot-sdk run build
RUN pnpm install --frozen-lockfile --ignore-scripts --offline --filter=@cyc-seattle/admin-functions... --filter=@cyc-seattle/clubspot-sync... --filter=@cyc-seattle/gsuite-sync...

COPY packages/admin-functions/ packages/admin-functions/
COPY packages/clubspot-sync/ packages/clubspot-sync/
COPY packages/gsuite-sync/ packages/gsuite-sync/
RUN pnpm --filter=@cyc-seattle/admin-functions --filter=@cyc-seattle/clubspot-sync --filter=@cyc-seattle/gsuite-sync run build

RUN pnpm deploy --ignore-scripts --filter=admin-functions --prod /usr/app/admin-functions
RUN pnpm deploy --ignore-scripts --filter=clubspot-sync --prod /usr/app/clubspot-sync
RUN pnpm deploy --ignore-scripts --filter=gsuite-sync --prod /usr/app/gsuite-sync

FROM base AS report-runner
COPY --from=build --chown=node:node /usr/app/admin-functions /usr/app/admin-functions
WORKDIR /usr/app/admin-functions
USER node
ENV NODE_ENV=production
CMD ["node", "./dist/main.js", "--logging", "json", "all"]

FROM base AS clubspot-sync
COPY --from=build --chown=node:node /usr/app/clubspot-sync /usr/app/clubspot-sync
WORKDIR /usr/app/clubspot-sync
USER node
ENV NODE_ENV=production
CMD ["node", "./dist/main.js", "--logging", "json"]

FROM base AS gsuite-sync
COPY --from=build --chown=node:node /usr/app/gsuite-sync /usr/app/gsuite-sync
WORKDIR /usr/app/gsuite-sync
USER node
ENV NODE_ENV=production
CMD ["node", "./dist/main.js", "--logging", "json"]
