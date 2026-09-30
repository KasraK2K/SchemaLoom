# syntax=docker/dockerfile:1
# Build from the repo ROOT: the api needs the workspace packages next to it.
#
#   docker build -f apps/api/Dockerfile -t schemaloom-api .                    # the server
#   docker build -f apps/api/Dockerfile --target migrate -t schemaloom-migrate .  # prisma migrate deploy
#
# Debian, not Alpine: Prisma's query engine and argon2's prebuilds target glibc.

FROM node:22-bookworm-slim AS base
# Prisma detects the OpenSSL version to pick its engine binary; slim ships the library only.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

FROM base AS build
# The lockfile alone decides the store, so this layer survives source edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc package.json ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm turbo build --filter=@schemaloom/api
# `deploy` copies the api with prod dependencies only and the workspace packages' dist.
# dist is gitignored, so packlist leaves the api's own build out: copy it explicitly.
RUN pnpm --filter @schemaloom/api deploy --prod --legacy /out \
  && cp -r apps/api/dist /out/dist

# One-shot job, run before each rollout. The prisma CLI is a devDependency, so it lives here
# and not in the server image. Needs DATABASE_URL (or the POSTGRES_* parts).
FROM build AS migrate
WORKDIR /repo/apps/api
CMD ["pnpm", "run", "db:deploy"]

FROM base AS runtime
# Phase 6 §2 — pg_dump for "read a database". From PGDG, not Debian: pg_dump refuses a server
# newer than itself and bookworm ships 15. Bump PG_CLIENT_MAJOR when PostgreSQL releases.
ARG PG_CLIENT_MAJOR=18
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && install -d /usr/share/postgresql-common/pgdg \
  && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list \
  && apt-get update && apt-get install -y --no-install-recommends postgresql-client-${PG_CLIENT_MAJOR} \
  && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/main.js"]
