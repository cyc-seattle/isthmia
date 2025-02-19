FROM node:20-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && npm install -g corepack@latest

FROM base AS build
COPY . /usr/src/app
WORKDIR /usr/src/app
RUN pnpm install \
    && pnpm run -r build \
    && pnpm deploy --legacy --filter=admin-functions --prod /usr/app/admin-functions

FROM base AS report-runner
COPY --from=build /usr/app/admin-functions /usr/app/admin-functions
WORKDIR /usr/app/admin-functions
ENV NODE_ENV=production
CMD ["node", "./dist/main.js", "--logging", "json", "all"]
