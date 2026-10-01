# Phase 6: live database import and drift check

Status: **approved 2026-09-29 with every default in §8** (user decision); §10–§11 approved
2026-09-30. Ready to build in the §9 order.

Roadmap rows 6a, 6b and 6c (`docs/ROADMAP.md`).

**This reverses one Phase 1 decision.** `docs/phase1/00-OVERVIEW.md` deleted the `Introspector`
and `features.introspection` because nothing needed them yet. This doc brings back a smaller
contract; 00-OVERVIEW points here.

---

## 0. The one idea

**Introspection produces import source, not IR.** The engine reads the live database and
returns text in one of its own `importFormats` (DDL for PostgreSQL). Everything after that is
the existing pipeline, unchanged: import preview, rename confirmation (Phase 4 Q1), additive
merge, `planImport` batching, the large-import job, `SchemaWriter`, `permGeneration`.

So there is no second import path and no second way to write schema data, and core learns
nothing about PostgreSQL.

## 1. Engine contract (`packages/engine-sdk/src/introspector.ts`)

```ts
export interface ConnectionField {
  readonly id: string; // 'host', 'port', 'database', 'user', 'password', 'sslmode', 'schemas'
  readonly label: string;
  readonly kind: 'text' | 'number' | 'secret' | 'select' | 'list';
  readonly required: boolean;
  readonly options?: readonly string[]; // for 'select'
  readonly default?: string | number;
}

export interface IntrospectRequest {
  readonly connection: Readonly<Record<string, string | number | readonly string[]>>;
  /** already resolved and checked by core (§3); the engine must connect to this address */
  readonly resolvedAddress: string;
  readonly signal: AbortSignal;
  readonly maxBytes: number;
}

export interface IntrospectResult {
  readonly source: string; // text in `format`
  readonly format: string; // an `importFormats` id
  readonly serverVersion: string; // shown in the preview, stored in the audit row
}

export interface Introspector {
  readonly connectionFields: readonly ConnectionField[];
  introspect(req: IntrospectRequest): Promise<IntrospectResult>;
}
```

- **As built (2026-09-30):** `connectionFields` lives on `capabilities`, not on the
  introspector, because the browser only ever sees capabilities (the static facet and
  `GET /engines`). `canIntrospect(capabilities)` is the helper, and
  `capabilities/services-match-features` checks it equals `introspector !== undefined`. Two
  field ids are conventions core reads: `host` (the SSRF guard) and `sslmode` (Q3). The
  "result is importable" check is the PostgreSQL engine's live spec
  (`introspector.spec.ts`, run with `INTROSPECT_TEST_URL`) rather than a conformance check,
  because conformance runs without a database.
- `EngineDefinition.introspector?: Introspector`. A derived helper `canIntrospect(engine)`
  replaces a feature atom, the same way Phase 1 replaced the other 23 atoms.
- `GET /engines` includes `connectionFields`, so the web renders the form without knowing any
  engine id (CLAUDE.md rule).
- Conformance: `introspect/result-is-importable`. When the engine's test database is
  available, its output must import with zero `failed` statements.

## 2. PostgreSQL introspector

**Run `pg_dump --schema-only`, don't write catalog queries.** `pg_dump` already handles every
edge case (partitions, generated and identity columns, extensions, domains, collations,
comments), and the importer already reads its output. A catalog-to-DDL renderer would be
thousands of lines that repeat that work.

- Command:
  `pg_dump --schema-only --no-owner --no-privileges [-n <schema>]...`.
  The password goes through the `PGPASSWORD` env var of the child process, **never argv**
  (argv shows up in `ps`). Connect with `hostaddr=<resolvedAddress>` plus `host=<name>` so
  TLS still verifies the name.
- Output is streamed and cut off at `maxBytes` (50 MB, `QUEUED_IMPORT_MAX_BYTES`). Over the
  limit → `413 introspect.too_large`.
- Timeouts: 10 s to connect, 120 s total, killed through `signal`.
- `pg_dump` refuses a server newer than itself. The api image ships the newest
  `postgresql-client` from the PGDG apt repo (Debian bookworm's own package is 15, too old).
  That adds one `apt-get` line to the `runtime` stage of `apps/api/Dockerfile`. A server that
  is still too new → `422 introspect.server_too_new`, which names both versions.
- Dev on Windows: the api finds `pg_dump` through `PG_DUMP_PATH`, or through `PATH` when that
  is unset. Missing → `503 introspect.not_available`, and the web hides the tab.
- Known import losses to call out in the preview (they already come back as `unsupported` or
  `ignored` statements): triggers, functions, policies, grants.

## 3. Security

These points are not optional. They are the reason this feature needs its own design doc.

1. **Credentials are never stored.** They live in the request body, the child process env
   and nothing else: not the job payload, not Redis, not S3, not the audit log. The pino
   redaction list gains `connection.*`. Saved connections are §7, a separate feature.
2. **SSRF guard in core, before the engine runs.** Resolve the host once and reject loopback,
   RFC 1918, link-local (including `169.254.169.254`), CGNAT, `::1`, `fc00::/7` and
   `fe80::/10`, unless `INTROSPECT_ALLOW_PRIVATE_HOSTS=true`. Self-hosters set that flag to
   read their own network, and it defaults to `false`. The engine connects to the address
   that was checked (`resolvedAddress`), so DNS rebinding can't swap it afterwards. The guard
   is `apps/api/src/introspect/address-guard.ts`, with a unit spec covering every range.
3. **TLS by default.** `sslmode` defaults to `require`. `disable` is allowed only when private
   hosts are allowed.
4. **Least privilege, and say so in the UI:** "Use a read-only role. SchemaLoom only reads the
   schema." `pg_dump --schema-only` reads no table data.
5. **Permission:** `@RequirePermission('schema:edit', { project: 'projectId' })`, the same
   atom as import, plus the full-view check (R21′) that import already does.
6. **Rate limit:** 10 introspections per user per hour and 100 per org per hour, on the same
   Redis counters as the AI limiter.
7. **Audit:** an `import.introspected` row with the host, database, server version and byte
   count, and no credentials.
8. **Kill switch:** `INTROSPECTION_ENABLED` (default `true`). When it's off, the routes
   return 404.

## 4. API (`apps/api/src/introspect/`)

| Route                                   | Marker                                       | What                                                                                                                                                                                                |
| --------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /projects/:id/introspect/preview` | `@RequirePermission('schema:edit', project)` | `{ connection }` → guard, run the introspector, store the source at `importObjectKey(projectId, uuid)`, run the existing `SnapshotsService.preview`. Returns `{ preview, sourceId, serverVersion }` |
| `POST /projects/:id/introspect/apply`   | `@RequirePermission('schema:edit', project)` | `{ sourceId, renames? }` → enqueues the **existing** import job with that storage key. Returns `{ jobId }`; status comes from the existing import-job route                                         |

- `sourceId` → `{ projectId, userId, storageKey }` sits in Redis with a 1 h TTL. `apply`
  from another user or project → 404, following "invisible is 404". The S3 object is deleted
  when the job finishes. A bucket lifecycle rule on the `imports/` prefix catches abandoned
  previews.
- Why two steps: the user sees what will be added before anything is written, and the
  database is read only once.
- Each controller gets its `*.routes.spec.ts`.

## 5. Web

- The canvas import dialog (`apps/web/src/features/canvas/import-dialog.tsx`) and
  `create-project.tsx` get a second tab, **"From a database"**, shown when the project's engine
  lists `connectionFields`. The form is generated from those fields, and the password input is
  `type="password" autocomplete="off"`.
- "Read schema" → preview. From there the existing preview UI takes over (creates, existing
  tables, rename proposals, statement report). "Import" → apply → the existing job progress.
- Errors map to plain messages: can't reach host, bad password, TLS failed, private address
  blocked (with a hint about the self-host flag), server too new, too large.

## 6. Drift check (roadmap 6b)

"Compare with a database" on the History screen.

- `POST /projects/:id/introspect/drift` `{ connection }`: the same guard, limits and audit as
  §3–§4. Introspect → run `importer.import` into an **in-memory** model (nothing written) →
  `diffModels(projectLiveIr, databaseIr)` from `packages/schema-model` → annotate with
  `engine.annotateDiff` → return the diff plus
  `migrationGenerator.generate(...)`, the SQL that brings the database in line with the
  design.
- **The full view is required**, as for migrations (Phase 5 Q1). A partial view would leak
  hidden tables through the diff. The diff never leaves the api unredacted, and `LiveIr`
  stays in `src/snapshots`.
- Web: reuse the History diff view and the "Migration SQL" panel. The "database" side is
  labeled with the host and time.
- Nothing is written. There is no "apply to database" button. SchemaLoom never writes to a
  user's database (see Q6).

## 7. Saved connections and scheduled drift (roadmap 6c, outline only)

A separate design doc before building. It must answer: encryption at rest (AES-256-GCM, key
from env or KMS, key rotation), who can use a saved connection versus who can see it, the
schedule (`upsertJobScheduler`, as the audit-retention job does), and the notification when
drift appears. Nothing in 6a or 6b may depend on it.

## 8. Open questions (defaults are the recommendation)

| #   | Question                                  | Default                                                                                                                                     |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | `pg_dump` binary vs. catalog queries      | **`pg_dump`.** Much less code; the cost is one binary in the image and a `PG_DUMP_PATH` for local dev.                                      |
| Q2  | Re-importing a changed database           | **Stays additive** (CLAUDE.md rule), plus the confirmed-rename exception. Drops and changes show up in the drift check (6b), not in import. |
| Q3  | Private hosts on the hosted service       | **Blocked**; self-host opts in with `INTROSPECT_ALLOW_PRIVATE_HOSTS=true`.                                                                  |
| Q4  | Which schemas                             | **All non-system schemas by default**; the `schemas` field narrows them.                                                                    |
| Q5  | Sync or async preview                     | **Sync with a 120 s cap.** Apply is already async. Move preview to a job only if real users hit the cap.                                    |
| Q6  | Ever write to the user's database         | **No.** SchemaLoom emits SQL; people run it with their own tools.                                                                           |
| Q7  | Connection string input as well as fields | **Yes, one "paste a URL" box** that fills the fields in the browser. The server only ever sees fields.                                      |

## 9. Build order and tests

1. SDK contract, `canIntrospect`, conformance check. Unit specs.
2. `address-guard.ts` with a spec for every blocked range and the allow flag.
3. PostgreSQL introspector. Int spec against the docker-compose Postgres (seed a schema,
   introspect, assert zero `failed` statements).
4. `introspect` module, routes spec, Redis `sourceId`, audit row, rate limit.
5. Web tab in both import entry points.
6. Dockerfile `postgresql-client` line; `docs/deploy.md` and `docs/self-host-ubuntu.md` get
   the two env vars.
7. E2E `workflow-7-introspect`: create project → read from the e2e database → import →
   tables on the canvas.
8. Drift (§6): route, History UI, e2e step that adds a column in the database and sees it
   in the drift diff.

Update `docs/ROADMAP.md` rows 6a and 6b as each lands.

---

## 10. SSH tunnel and certificate files (added 2026-09-30)

Status: **approved 2026-09-30** (user decision: an optional host-key pin, key or password login,
CA plus client certificate and key). Many databases are reachable only through a bastion, and
`verify-ca` / `verify-full` are useless without a way to hand over the CA.

### 10.1 Contract

`ConnectionField` gains three optional members. The form and the api's validation are still
generated from `connectionFields` alone, so no engine id appears in core or the web.

```ts
readonly kind: 'text' | 'number' | 'secret' | 'select' | 'list' | 'file';
/** heading the web groups fields under ("SSH tunnel", "TLS") */
readonly section?: string;
/** shown, validated and sent only while `field` is visible and its value is in `in` */
readonly showWhen?: { readonly field: string; readonly in: readonly string[] };
```

- `file` is PEM text. The browser offers a file picker and a paste box, and sends the text.
  The api accepts up to 256 KB and requires `-----BEGIN`.
- `visibleFields(fields, values)` in the SDK is the one visibility rule, used by both the web
  and the api. It's transitive: a field is hidden when the field it depends on is hidden.
  Required-ness applies only to visible fields, and hidden values are dropped.
- `SSH_TUNNEL_FIELDS` in the SDK is the SSH part of the form. An engine that talks TCP spreads
  it into its `connectionFields`. The ids are conventions core reads (like `host` and
  `sslmode`): `ssh` (`none` | `ssh`), `ssh_host`, `ssh_port`, `ssh_user`, `ssh_auth`
  (`key` | `password`), `ssh_private_key` (`file`), `ssh_passphrase`, `ssh_password`,
  `ssh_host_key`.

### 10.2 TLS files (PostgreSQL engine)

`sslrootcert` (CA certificate, shown for `verify-ca` and `verify-full`), plus `sslcert` and
`sslkey` (client certificate and key, shown for every mode except `disable`). The introspector
writes them into a fresh `mkdtemp` directory with mode `0600`, points `PGSSLROOTCERT`,
`PGSSLCERT` and `PGSSLKEY` at them, and removes the directory when `pg_dump` exits, however it
exits. An empty CA under `verify-full` means `PGSSLROOTCERT=system`, the OS trust store. libpq only
allows `system` with `verify-full`, so `verify-ca` needs the CA.

### 10.3 SSH tunnel (core, `apps/api/src/introspect/ssh-tunnel.ts`)

Engine-agnostic, so it lives in core. It uses the `ssh2` package, a new api dependency, because
SSH can't be done in a few lines, and spawning `ssh -L` would need key files and a
`known_hosts` on disk.

1. **The SSRF guard checks `ssh_host`**, because that's what the api connects to. The database
   `host` is resolved by the bastion, and reaching a private database behind it is the point.
2. **Host key:** every connection computes the bastion key's `SHA256:` fingerprint. If
   `ssh_host_key` is set and doesn't match, the connection is refused before authentication
   (`introspect.ssh_host_key_mismatch`). If it's empty, the connection goes ahead and the
   fingerprint comes back in the response (`sshHostKey`). The result screen shows it, with a
   note to check it and paste it into the field next time (connection details aren't kept, so
   there's nothing to pin it to yet; saved connections in §7 will).
3. The tunnel listens on `127.0.0.1:0` for one read. The engine gets `resolvedAddress:
127.0.0.1` and the tunnel's port in place of `port` (a third conventional id), while `host`
   stays as typed, so `verify-full` still checks the database's name. The tunnel closes in `finally`, and a 20 s handshake timeout applies.
4. `sslmode=disable` is allowed through a tunnel even without the private-hosts flag: the leg
   the api can see is SSH-encrypted.
5. Errors: `introspect.ssh_unreachable`, `introspect.ssh_auth_failed` and
   `introspect.ssh_host_key_mismatch` (all 422). None echoes a key, passphrase or password.
6. The audit row gains `sshHost` and `sshHostKey`. Credentials stay where §3.1 says, and pino's
   `connection.*` redaction already covers the new ids.

## 11. Everything in Docker (added 2026-09-30)

Status: **approved 2026-09-30** (user decision: one command). People shouldn't have to install
`pg_dump`, or anything else, to use SchemaLoom.

- `apps/web/Dockerfile`: a Next.js standalone build. `NEXT_PUBLIC_API_URL` is a build argument,
  because Next bakes it into the browser bundle.
- `docker-compose.yml` gains, with no profile, `migrate` (one-shot; the api waits for it),
  `api` (the image with `pg_dump`), `web`, and `proxy` (Caddy on `http://localhost:8080`).
  Caddy sends `/api/*` and `/socket.io/*` to the api and everything else to the web app,
  keeping one hostname (CLAUDE.md rule). Only the proxy publishes a port.
- `cp .env.example .env && docker compose up -d` is the whole setup. The app
  services take secrets from `.env` and override the URLs to service names. The first `up`
  builds the images; `--build` picks up a newer checkout. `pnpm infra:up` names only the four
  infra services, so development never builds the app images. `pnpm dev` is
  unchanged.
- To read a database on the same machine, use `host.docker.internal` as the host.
  `localhost` inside the api container is the container.
