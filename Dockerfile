FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && npm install -g corepack@latest

FROM base AS build
WORKDIR /usr/src/app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.json ./

# admin-functions and the workspace dependencies it needs at runtime.
COPY packages/admin-functions/ packages/admin-functions/
COPY packages/clubspot-sdk/ packages/clubspot-sdk/
COPY packages/clubspot-sync/ packages/clubspot-sync/
COPY packages/commodore/ packages/commodore/
COPY packages/gsuite/ packages/gsuite/

# Not part of the image, but the root package.json devDepends on both (workspace:*), so pnpm runs
# their `prepare` (tsc build) during install regardless of --filter.
COPY packages/calendar-sync/ packages/calendar-sync/
COPY packages/todo-manager/ packages/todo-manager/

# pnpm reads every workspace member named in the lockfile, so the rest still need a manifest even
# though their source never enters the image (#114).
COPY packages/infrastructure/package.json packages/infrastructure/
COPY packages/people-hub/package.json packages/people-hub/
COPY packages/portal/package.json packages/portal/
COPY packages/substrate/package.json packages/substrate/

RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter=@cyc-seattle/admin-functions... --filter=@cyc-seattle/clubspot-sync...
RUN pnpm deploy --ignore-scripts --filter=admin-functions --prod /usr/app/admin-functions
RUN pnpm deploy --ignore-scripts --filter=clubspot-sync --prod /usr/app/clubspot-sync

FROM base AS report-runner
COPY --from=build /usr/app/admin-functions /usr/app/admin-functions
WORKDIR /usr/app/admin-functions
ENV NODE_ENV=production
CMD ["node", "./dist/main.js", "--logging", "json", "all"]

FROM base AS clubspot-sync
COPY --from=build /usr/app/clubspot-sync /usr/app/clubspot-sync
WORKDIR /usr/app/clubspot-sync
ENV NODE_ENV=production
CMD ["node", "./dist/main.js", "--logging", "json"]
