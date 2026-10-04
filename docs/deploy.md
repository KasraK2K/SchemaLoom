# Deploying SchemaLoom

**The web app and the api must share one hostname**, for example `app.example.com`, with a
reverse proxy sending `/api/*` and `/socket.io/*` to the api and everything else to the web
app. The api refuses to boot when `API_PUBLIC_URL` and `WEB_PUBLIC_URL` name different hosts.

The reason: the session cookies (`sl_access`, `sl_refresh`) are host-only on the api's host,
and the web app's server-rendered pages forward the browser's cookies to the api. On two
hostnames (`app.` and `api.`) the web server never receives `sl_access`, so every signed-in
page redirects to `/login` and back, forever. That was reproduced on 2026-09-29. Sharing the
cookie across subdomains would fix it, but it hands a live session token to every subdomain,
which doc 01 §5.4 rules out. Vercel is off the table for the same reason: it can proxy
`/api` but not the Socket.IO WebSocket.

`docs/self-host-ubuntu.md` is a complete single-server setup with Caddy. The pieces:

| Piece                                                          | Runs on                                | Built from                                  |
| -------------------------------------------------------------- | -------------------------------------- | ------------------------------------------- |
| Reverse proxy (TLS, path routing, WebSocket upgrades)          | Caddy, nginx or a load balancer        | —                                           |
| `apps/web`                                                     | Node 22, `next start`                  | `pnpm turbo build --filter=@schemaloom/web` |
| `apps/api` (HTTP, WebSocket and the in-process BullMQ workers) | any container host                     | `apps/api/Dockerfile`, target `runtime`     |
| Migrations                                                     | a one-shot job before each api rollout | `apps/api/Dockerfile`, target `migrate`     |
| PostgreSQL 16, Redis 7, S3-compatible storage, Mailgun or SMTP | managed services or containers         | —                                           |

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
- **WebSockets:** realtime uses Socket.IO at `/socket.io/`, so the proxy must pass
  WebSocket upgrades through to the api.
- **Compression:** the api gzips its own responses (the IR for a 300-table project is about
  2.1 MB of JSON and 380 KB gzipped). The AI assistant's event stream is sent uncompressed
  so it isn't buffered. Turn off compression at the proxy for `text/event-stream` too.
- **Audit-log retention:** a nightly job (03:15 UTC) deletes `audit_log` rows older than
  24 months (doc 00 Q10). Nothing else is deleted. Owners and admins read and export it in
  Settings → Audit log (CSV, up to 100,000 rows per download); hand a customer their trail
  before it ages out.
- **Single sign-on (roadmap 14):** org owners add OIDC or SAML connections in Settings →
  Single sign-on, which shows the redirect URI / ACS URL / entity ID to paste into the IdP.
  SSO needs HTTPS (its state cookie is `SameSite=None; Secure`), and the api must reach the
  OIDC issuer; an issuer on a private address works only with `INTROSPECT_ALLOW_PRIVATE_HOSTS`.
  Client secrets are encrypted with `SECRETS_ENCRYPTION_KEY`, so changing that key means
  re-entering them. On an install shared by unrelated companies, keep JIT off (any owner can
  list any domain; `docs/phase14/DESIGN.md`).
- **Engine major bumps:** projects on an older engine major are read-only (writes answer 423) until an operator runs `node dist/engine-upgrade.cli.js --all` in the api image. Each
  project converts in one transaction or not at all.
- **Expression refs (once, upgrading from before 2026-10-04):** run
  `node dist/refs-backfill.cli.js` in the api image. Older rows have no `refs`, so partial
  viewers see every default, CHECK and view body blanked, and an index or constraint name that
  mentions a hidden column isn't badged. Safe to re-run; new writes keep refs current.
- **Replicas and a separate worker (roadmap 20):** by default (`PROCESS_ROLE=all`,
  `REALTIME_BUS=local`) run **one** api: it serves HTTP and WebSocket and runs every BullMQ
  worker. To scale out, set `REALTIME_BUS=redis` on every process (realtime events then go
  through Redis pub/sub, so each api replica pushes them to its own sockets), run the api with
  `PROCESS_ROLE=api` (as many replicas as you like; Socket.IO runs WebSocket-only, so the proxy
  needs no sticky sessions), and run one or more
  workers from the same image with `PROCESS_ROLE=worker` and `node dist/worker.js` (no port, no
  `/healthz`). `docker compose --profile split up -d` starts one. The api refuses to boot with a
  split role and `REALTIME_BUS=local`.

### Environment

`.env.example` lists every variable. For production, in addition to the required ones:

| Variable                                                                           | Value                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                         | `production` (set by the image). Forces `COOKIE_SECURE`.                                                                                                                                                                                                                                            |
| `API_PUBLIC_URL` / `WEB_PUBLIC_URL`                                                | both `https://app.example.com` (one hostname; see the top of this page)                                                                                                                                                                                                                             |
| `COOKIE_DOMAIN`                                                                    | leave unset: on one hostname every cookie is host-only                                                                                                                                                                                                                                              |
| `TRUST_PROXY`                                                                      | How many proxies sit in front of the api, usually `1` for a load balancer. With `0` every visitor shares the balancer's IP and the per-IP rate limits apply to all of them together. Setting it too high lets a client spoof `X-Forwarded-For`.                                                     |
| `DATABASE_URL`                                                                     | the managed database's URL (it overrides the `POSTGRES_*` parts)                                                                                                                                                                                                                                    |
| `REDIS_URL`                                                                        | the managed Redis                                                                                                                                                                                                                                                                                   |
| `S3_*`                                                                             | the bucket. `S3_PUBLIC_URL` is the address browsers use for presigned URLs. The api creates the bucket on boot if it doesn't exist.                                                                                                                                                                 |
| `MAILGUN_API_KEY` + `MAILGUN_DOMAIN`, or `SMTP_URL`                                | mail. Mailgun wins when both are set; `MAILGUN_API_URL=https://api.eu.mailgun.net` for an EU-region domain                                                                                                                                                                                          |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `CSRF_SECRET`, `SECRETS_ENCRYPTION_KEY` | fresh values, generated as `.env.example` shows. Don't copy them from dev.                                                                                                                                                                                                                          |
| `ANTHROPIC_API_KEY`                                                                | optional. Without it, the AI routes answer 503.                                                                                                                                                                                                                                                     |
| `INTROSPECT_ALLOW_PRIVATE_HOSTS`                                                   | "Read a database" refuses private and internal addresses (RFC 1918, loopback, link-local, the cloud metadata address) unless this is `true`. Keep it `false` on a service open to the internet. The api image ships `pg_dump` (`PG_CLIENT_MAJOR` build arg); MySQL and MariaDB need no client tool. |
| `INTROSPECTION_ENABLED`                                                            | optional, default `true`. `false` removes "Read a database" and the drift check (their routes answer 404).                                                                                                                                                                                          |
| `SIGNUP_MODE`                                                                      | optional, default `invite`: only the first account signs up freely (it becomes the owner of the org it creates), and everyone after joins through an invitation from Settings → Members. Set `open` for a hosted service where anyone may sign up.                                                  |

**Upgrading an install that relied on open sign-up:** from roadmap 16 on, sign-up closes once
an account exists. Existing accounts keep working. To keep letting strangers sign up, set
`SIGNUP_MODE=open`.

**Changing `SECRETS_ENCRYPTION_KEY`** makes everything encrypted under the old key unreadable,
including saved database connections (`docs/phase6/SAVED-CONNECTIONS.md`). There is no
re-encryption job. After the change, Sync and Compare answer "can't be read with this server's
key" (409 `connection.undecryptable`), and a project manager re-enters the connection's
passwords and keys with **Edit connection**. Keep the key in your secret store, not only in the
server's `.env`.

## 3. The web app

`NEXT_PUBLIC_*` values are inlined into the browser bundle at build time, so set them for the
build and rebuild after changing them:

```bash
NEXT_PUBLIC_API_URL=https://app.example.com NEXT_PUBLIC_APP_URL=https://app.example.com   pnpm turbo build --filter=@schemaloom/web
cd apps/web && NODE_ENV=production API_INTERNAL_URL=http://127.0.0.1:3001   node node_modules/next/dist/bin/next start -p 3000 -H 127.0.0.1
```

| Variable              | Value                                                                       |
| --------------------- | --------------------------------------------------------------------------- |
| `NEXT_PUBLIC_API_URL` | `https://app.example.com`, the shared hostname                              |
| `NEXT_PUBLIC_APP_URL` | `https://app.example.com`                                                   |
| `API_INTERNAL_URL`    | optional: a private address server components use to reach the api directly |

Nothing else needs to be set: the api's `CORS_ORIGINS` defaults to `WEB_PUBLIC_URL`.

## 4. The CLI and CI (API tokens)

`schemaloom` (`packages/cli`) talks to the same hostname as the browser, through the proxy's
`/api` route, with `Authorization: Bearer slt_…`. Nothing extra needs to be deployed or
configured: a bearer request carries no cookies, so CSRF and CORS don't apply to it.

- Each token is limited to 120 requests a minute, in Redis like the share-link limits.
- `schemaloom diff` reads the project's saved connection on the api (`pg_dump` for
  PostgreSQL), so it needs the same `INTROSPECTION_ENABLED` and `pg_dump` setup as **Compare now**.
- Tokens are hashed at rest (sha256). Rotating `JWT_ACCESS_SECRET` or
  `SECRETS_ENCRYPTION_KEY` does not affect them. Revoke them under Account → API tokens or
  in the project's Settings.

Copy-paste CI jobs are in `docs/ci.md`.
