# syntax=docker/dockerfile:1
# Phase 6 §11 — the web app. Build from the repo ROOT (it needs the workspace packages):
#
#   docker build -f apps/web/Dockerfile -t schemaloom-web .
#
# NEXT_PUBLIC_* is inlined into the browser bundle at BUILD time, so the public URL is a
# build argument, not a runtime setting. It's where the browser reaches the api: the same
# host as the web app, behind the proxy (docs/deploy.md).

# These first layers are the api Dockerfile's, word for word, so Docker reuses its cached
# `pnpm fetch` and the packages are downloaded once for both images. Keep them in step.
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl   && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
ARG NEXT_PUBLIC_API_URL=http://localhost:8080
ARG NEXT_PUBLIC_APP_URL=http://localhost:8080
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_OUTPUT=standalone \
    NODE_ENV=production
RUN pnpm turbo build --filter=@schemaloom/web

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
# standalone has server.js and the traced node_modules; static and public are copied beside it.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
