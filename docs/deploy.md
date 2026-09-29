# Deploying SchemaLoom

This follows the Q14 default in `docs/phase1/00-OVERVIEW.md`: **the web app on Vercel and the
api in a container**, with both under one registrable domain (Q13), for example
`app.example.com` and `api.example.com`.

| Piece                                                          | Runs on                                | Built from                              |
| -------------------------------------------------------------- | -------------------------------------- | --------------------------------------- |
| `apps/web`                                                     | Vercel                                 | `apps/web/vercel.json`                  |
| `apps/api` (HTTP, WebSocket and the in-process BullMQ workers) | any container host                     | `apps/api/Dockerfile`, target `runtime` |
| Migrations                                                     | a one-shot job before each api rollout | `apps/api/Dockerfile`, target `migrate` |
| PostgreSQL 16, Redis 7, S3-compatible storage, SMTP or Resend  | managed services                       | —                                       |

## 1. Create the database with a pinned collation (once, before anything else)

A database's collation **cannot be changed in place**. Text indexes are ordered by it, so
picking the wrong one means a dump and restore later. Create the database yourself instead of
letting the provider's default decide:

```sql
CREATE DATABASE schemaloom
  TEMPLATE template0
  ENCODING 'UTF8'
  LOCALE_PROVIDER icu
  ICU_LOCALE 'en-US'
  LOCALE 'C';
```

ICU sorts the same way on every OS image, so a host OS upgrade can't silently change sort
order the way glibc updates can. `LOCALE 'C'` only sets the libc fallback. Check it:

```sql
SELECT datname, datlocprovider, daticulocale, datcollate
FROM pg_database WHERE datname = 'schemaloom';
-- schemaloom | i | en-US | C
```

Redis must run with `maxmemory-policy noeviction`, because BullMQ loses jobs under any other
policy. `docker-compose.yml` shows the settings.

## 2. The api container

```bash
docker build -f apps/api/Dockerfile -t schemaloom-api .
docker build -f apps/api/Dockerfile --target migrate -t schemaloom-migrate .
```

Build from the repo root. Before each rollout, run `schemaloom-migrate` once with the same
database settings as the api. It runs `prisma migrate deploy`, which holds an advisory lock,
so a second copy started at the same time just waits. Then roll out `schemaloom-api`.

- **Port:** `PORT` (default 3001).
- **Probes:** liveness `GET /healthz` (process only), readiness `GET /readyz` (Postgres and
  Redis). The image also declares a Docker `HEALTHCHECK` on `/healthz`.
- **WebSockets:** realtime uses Socket.IO on the api origin, so the host and its load
  balancer must allow WebSocket upgrades.
- **Compression:** the api gzips its own responses (the IR for a 300-table project is about
  2.1 MB of JSON and 380 KB gzipped). The AI assistant's event stream is sent uncompressed
  so it isn't buffered. Turn off compression at the proxy for `text/event-stream` too.
- **Replicas:** run **one**. Realtime is single-node (phase4 DESIGN) and the BullMQ
  workers are in-process (Q30).

### Environment

`.env.example` lists every variable. For production, in addition to the required ones:

| Variable                                                                           | Value                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                         | `production` (set by the image). Forces `COOKIE_SECURE`.                                                                                                                                                                                        |
| `API_PUBLIC_URL` / `WEB_PUBLIC_URL`                                                | `https://api.example.com` / `https://app.example.com`                                                                                                                                                                                           |
| `COOKIE_DOMAIN`                                                                    | `.example.com`. The web middleware reads `sl_presence` on the app host, so this is required when the two are on different subdomains.                                                                                                           |
| `TRUST_PROXY`                                                                      | How many proxies sit in front of the api, usually `1` for a load balancer. With `0` every visitor shares the balancer's IP and the per-IP rate limits apply to all of them together. Setting it too high lets a client spoof `X-Forwarded-For`. |
| `DATABASE_URL`                                                                     | the managed database's URL (it overrides the `POSTGRES_*` parts)                                                                                                                                                                                |
| `REDIS_URL`                                                                        | the managed Redis                                                                                                                                                                                                                               |
| `S3_*`                                                                             | the bucket. `S3_PUBLIC_URL` is the address browsers use for presigned URLs. The api creates the bucket on boot if it doesn't exist.                                                                                                             |
| `RESEND_API_KEY` or `SMTP_URL`                                                     | mail                                                                                                                                                                                                                                            |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `CSRF_SECRET`, `SECRETS_ENCRYPTION_KEY` | fresh values, generated as `.env.example` shows. Don't copy them from dev.                                                                                                                                                                      |
| `ANTHROPIC_API_KEY`                                                                | optional. Without it, the AI routes answer 503.                                                                                                                                                                                                 |

## 3. The web app on Vercel

Create a Vercel project from this repository with **Root Directory `apps/web`**. Vercel picks
up `apps/web/vercel.json`, installs with pnpm from the workspace root, and builds through
turbo so the workspace packages are built first.

| Variable              | Value                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | `https://api.example.com`. This is inlined at build time, so redeploy after changing it. |
| `NEXT_PUBLIC_APP_URL` | `https://app.example.com`                                                                |
| `API_INTERNAL_URL`    | optional: a private address server components can use to reach the api                   |

Nothing else needs to be set: the api's `CORS_ORIGINS` defaults to `WEB_PUBLIC_URL`.
