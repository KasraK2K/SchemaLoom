# Running SchemaLoom in production on one Ubuntu server

This guide puts everything on one Ubuntu 24.04 machine:

| Piece                         | How it runs                                            |
| ----------------------------- | ------------------------------------------------------ |
| Caddy                         | apt package; HTTPS certificates and the reverse proxy  |
| PostgreSQL 16, Redis 7, MinIO | Docker Compose                                         |
| api                           | Docker Compose, image built from `apps/api/Dockerfile` |
| Migrations                    | a one-shot container, run before each api update       |
| web                           | Node 22 under systemd (`next start`)                   |

It uses **two hostnames**, both pointing at the server:

- `app.example.com` serves the web app and the api. Caddy sends `/api/*` and `/socket.io/*`
  to the api and everything else to the web app.
- `files.example.com` serves MinIO, so browsers can download exports and upload images
  through presigned URLs.

The web app and api share one hostname on purpose. The api's session cookie (`sl_access`)
is host-only, and the web server forwards the visitor's cookies to the api when it renders a
page. Both only work when the browser sends that cookie to the web app too, which means one
host. Replace `example.com` with your domain throughout.

## 1. Prepare the server

Point DNS A (and AAAA) records for `app.example.com` and `files.example.com` at the server.
Then:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git docker.io docker-compose-v2 caddy
sudo usermod -aG docker "$USER"   # log out and back in afterwards
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw enable
```

Install Node 22 (the version in `.nvmrc`) from NodeSource, then enable pnpm through
corepack:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x -o nodesource_setup.sh
less nodesource_setup.sh          # read it before running it
sudo bash nodesource_setup.sh && sudo apt install -y nodejs
sudo corepack enable
```

## 2. Get the code

```bash
sudo mkdir -p /opt/schemaloom && sudo chown "$USER": /opt/schemaloom
git clone <your repository URL> /opt/schemaloom/app
```

Don't create a `.env` inside `/opt/schemaloom/app`. The production settings live one level
up, and a dev `.env` in the repo sets `NODE_ENV=development`, which breaks `next build`.

## 3. Write the settings

Create `/opt/schemaloom/.env`. Docker Compose reads it for the database and MinIO passwords,
and the api container gets the whole file.

```bash
cd /opt/schemaloom
secret() { node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"; }
cat > .env <<EOF
NODE_ENV=production
PORT=3001
LOG_LEVEL=info
TRUST_PROXY=1

API_PUBLIC_URL=https://app.example.com
WEB_PUBLIC_URL=https://app.example.com

POSTGRES_USER=schemaloom
POSTGRES_PASSWORD=$(openssl rand -hex 24)
POSTGRES_DB=schemaloom
POSTGRES_HOST=postgres
POSTGRES_PORT=5432

REDIS_URL=redis://redis:6379
REDIS_KEY_PREFIX=sl:

JWT_ACCESS_SECRET=$(secret)
JWT_REFRESH_SECRET=$(secret)
CSRF_SECRET=$(secret)
SECRETS_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")

MAIL_FROM=SchemaLoom <no-reply@mg.example.com>
MAILGUN_API_KEY=your-mailgun-api-key
MAILGUN_DOMAIN=mg.example.com

S3_ENDPOINT=http://minio:9000
S3_PUBLIC_URL=https://files.example.com
S3_BUCKET=schemaloom
S3_ACCESS_KEY_ID=schemaloom
S3_SECRET_ACCESS_KEY=$(openssl rand -hex 24)
EOF
chmod 600 .env
```

Then edit it:

- **Mail:** set `MAILGUN_API_KEY` and `MAILGUN_DOMAIN` (your sending domain, for example
  `mg.example.com`), and make `MAIL_FROM` an address on that domain. For a domain in Mailgun's EU
  region, also set `MAILGUN_API_URL=https://api.eu.mailgun.net`. To use another provider, delete
  the two Mailgun lines and set `SMTP_URL` instead.
  Sign-up, invitations and password resets all send email, so set this up first.
- **Optional:** add `ANTHROPIC_API_KEY=...` for the AI assistant, and
  `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` for Google sign-in (callback
  `https://app.example.com/api/auth/google/callback`).
- **`COOKIE_DOMAIN`:** leave it unset. With one host, every cookie stays host-only.
- **Who can sign up:** by default (`SIGNUP_MODE=invite`) only the first person to sign up gets
  in on their own. That account creates the organisation and is its owner; invite everyone else
  from **Settings → Members**. Sign up yourself right after the first start. Set
  `SIGNUP_MODE=open` only if anyone who reaches the site should be able to create an account.
- **Reading databases on your own network:** "Read a database" refuses private addresses
  (`10.x`, `192.168.x`, `localhost`, …) by default. If the databases you want to import live on
  your network, set `INTROSPECT_ALLOW_PRIVATE_HOSTS=true`. Every read is written to the audit log.

## 4. Start the database, Redis and MinIO

Create `/opt/schemaloom/compose.yml`:

```yaml
name: schemaloom

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      # Not the app database: that one is created by hand in step 5, with a pinned collation.
      POSTGRES_DB: postgres
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${POSTGRES_USER} -d postgres']
      interval: 5s
      retries: 20

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    # noeviction: BullMQ loses jobs under any other policy.
    command: ['redis-server', '--appendonly', 'yes', '--maxmemory-policy', 'noeviction']
    volumes:
      - redis-data:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      retries: 20

  minio:
    image: quay.io/minio/minio:latest
    restart: unless-stopped
    command: ['server', '/data']
    environment:
      MINIO_ROOT_USER: ${S3_ACCESS_KEY_ID}
      MINIO_ROOT_PASSWORD: ${S3_SECRET_ACCESS_KEY}
    ports:
      - '127.0.0.1:9000:9000'
    volumes:
      - minio-data:/data

  api:
    image: schemaloom-api
    restart: unless-stopped
    env_file: .env
    ports:
      - '127.0.0.1:3001:3001'
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      minio: { condition: service_started }

  migrate:
    image: schemaloom-migrate
    profiles: ['tools']
    env_file: .env
    depends_on:
      postgres: { condition: service_healthy }

volumes:
  postgres-data:
  redis-data:
  minio-data:
```

Only Caddy is reachable from outside: the api and MinIO listen on `127.0.0.1`, and Postgres
and Redis publish no ports at all. If `quay.io` is blocked on your network, the dev compose
file's `bitnamilegacy/minio` image works as well (volume path `/bitnami/minio/data`).

```bash
cd /opt/schemaloom
docker compose up -d postgres redis minio
```

## 5. Create the database (once)

The collation can't be changed later without a dump and restore, so create the database
yourself (see `docs/deploy.md` §1 for why ICU):

```bash
docker compose exec postgres psql -U schemaloom -d postgres -c \
  "CREATE DATABASE schemaloom TEMPLATE template0 ENCODING 'UTF8' LOCALE_PROVIDER icu ICU_LOCALE 'en-US' LOCALE 'C';"
```

## 6. Build and start the api

```bash
cd /opt/schemaloom/app
docker build -f apps/api/Dockerfile -t schemaloom-api .
docker build -f apps/api/Dockerfile --target migrate -t schemaloom-migrate .

cd /opt/schemaloom
docker compose run --rm migrate      # prints "All migrations have been successfully applied."
docker compose up -d api
curl -s http://127.0.0.1:3001/readyz # {"status":"ok",...}
```

On first boot the api creates the MinIO bucket and registers its nightly jobs.

## 7. Build and start the web app

`NEXT_PUBLIC_*` values are baked into the browser bundle at build time, so they're set
here, and changing them later means rebuilding.

```bash
cd /opt/schemaloom/app
pnpm install --frozen-lockfile
NEXT_PUBLIC_API_URL=https://app.example.com NEXT_PUBLIC_APP_URL=https://app.example.com \
  pnpm turbo build --filter=@schemaloom/web
```

Create `/etc/systemd/system/schemaloom-web.service`, replacing `YOUR_USER` with the account
that owns `/opt/schemaloom`:

```ini
[Unit]
Description=SchemaLoom web
After=network-online.target docker.service

[Service]
User=YOUR_USER
WorkingDirectory=/opt/schemaloom/app/apps/web
Environment=NODE_ENV=production
Environment=NEXT_PUBLIC_API_URL=https://app.example.com
Environment=NEXT_PUBLIC_APP_URL=https://app.example.com
# Server-rendered pages call the api directly instead of going out through Caddy.
Environment=API_INTERNAL_URL=http://127.0.0.1:3001
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 3000 -H 127.0.0.1
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now schemaloom-web
```

## 8. Configure Caddy

Replace `/etc/caddy/Caddyfile` with:

```caddy
app.example.com {
	@api path /api/* /socket.io/*
	reverse_proxy @api 127.0.0.1:3001
	reverse_proxy 127.0.0.1:3000
}

files.example.com {
	reverse_proxy 127.0.0.1:9000
}
```

```bash
sudo systemctl reload caddy
```

Caddy gets the TLS certificates by itself once DNS points at the server and ports 80 and 443
are open. Three things here are deliberate:

- **No `encode` directive.** The api gzips its own responses, and compressing the AI
  assistant's event stream again would buffer it.
- **WebSockets:** Caddy passes the Socket.IO upgrade through without extra configuration.
- **Presigned URLs:** Caddy keeps the `Host` header, which presigned URLs need, because they
  are signed for `files.example.com`.

Open `https://app.example.com`, sign up, and check that the verification email arrives.

## 9. Updating

```bash
cd /opt/schemaloom/app && git pull
docker build -f apps/api/Dockerfile -t schemaloom-api .
docker build -f apps/api/Dockerfile --target migrate -t schemaloom-migrate .
cd /opt/schemaloom && docker compose run --rm migrate && docker compose up -d api

cd /opt/schemaloom/app && pnpm install --frozen-lockfile
NEXT_PUBLIC_API_URL=https://app.example.com NEXT_PUBLIC_APP_URL=https://app.example.com \
  pnpm turbo build --filter=@schemaloom/web
sudo systemctl restart schemaloom-web
```

Always run `migrate` before starting the new api.

Updating from a version before invite-only sign-up (roadmap 16) closes sign-up for new people
unless `.env` has `SIGNUP_MODE=open`. Existing accounts are not affected.

If the release bumps an engine's **major** version, projects on the old major open read-only
until their stored props are converted. Run this once after the new api is up; it prints one
line per project it changes and exits non-zero if any project failed:

```bash
docker compose run --rm api node dist/engine-upgrade.cli.js --all
```

Upgrading from a release before 2026-10-04, also run this once. It records which columns
each default, CHECK and view names, so viewers with partial access see the expressions they
are allowed to see:

```bash
docker compose run --rm api node dist/refs-backfill.cli.js
```

## 10. Backups

The data lives in three Docker volumes. Postgres is the one that matters most. A nightly dump
from cron (`crontab -e`):

```cron
0 2 * * * cd /opt/schemaloom && docker compose exec -T postgres pg_dump -U schemaloom -Fc schemaloom > /opt/schemaloom/backups/db-$(date +\%F).dump && find /opt/schemaloom/backups -name 'db-*.dump' -mtime +14 -delete
```

Create `/opt/schemaloom/backups` first, and copy the dumps off the server. Back up the
`minio-data` volume (exports and uploaded images) and `/opt/schemaloom/.env` as well:
without the `.env` secrets, existing sessions and stored TOTP secrets can't be read.

Restore into a freshly created database (step 5):
`docker compose exec -T postgres pg_restore -U schemaloom -d schemaloom < db-YYYY-MM-DD.dump`.

## Troubleshooting

| Symptom                                               | Check                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| "Something went wrong on our side" at sign-in         | `docker compose run --rm migrate`: an unmigrated database                                  |
| The api keeps restarting                              | `docker compose logs api`: an invalid setting is listed by name at boot                    |
| Every visitor hits the share-link rate limit together | `TRUST_PROXY=1` is missing                                                                 |
| Export downloads fail                                 | `S3_PUBLIC_URL` must be `https://files.example.com`, and the Caddy block for it must exist |
| AI panel says it's not configured                     | `ANTHROPIC_API_KEY` is unset; that's expected without it                                   |
| "Read a database" says the host is private            | `INTROSPECT_ALLOW_PRIVATE_HOSTS=true` for a database on your own network                   |
| "Read a database" says the server is newer            | rebuild the api image with a higher `--build-arg PG_CLIENT_MAJOR=`                         |
| Sync says the saved connection can't be read          | `SECRETS_ENCRYPTION_KEY` changed: re-enter it with Edit connection (`docs/deploy.md`)      |
| Web logs "API unreachable"                            | `API_INTERNAL_URL` and `docker compose ps api`                                             |

Audit-log rows older than 24 months are deleted nightly (doc 00 Q10). If a customer needs
their history, export it before then.
