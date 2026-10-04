# Operations leftovers: worker process, realtime over Redis, CI cache, test isolation (roadmap 20)

Status: **built** 2026-10-04 (approved the same day with every default; Q4 left Q32
unbuilt on purpose).

**As built:**

- §1: `PROCESS_ROLE` and `REALTIME_BUS` in `env.ts` (a split role with the local bus refuses
  to boot). `runsJobs()` gates the four places that start a worker or a schedule (`JOB_WORKERS`,
  `JobsRuntime`, the AI doc-draft worker, `DriftSweepRuntime`). `src/worker.ts` is
  `NestFactory.createApplicationContext(AppModule)`: the same modules, no HTTP or WebSocket
  server; `main.ts` refuses `PROCESS_ROLE=worker`. `RealtimeBus` re-routes the four channels'
  `next` (schema commits, access changes, comment changes, notifications) through Redis
  pub/sub with the key prefix in the channel name; a worker publishes only. Compose has a
  `worker` service under the `split` profile. Verified by running the whole e2e suite against
  one `api` and one `worker` process.
- §2: `ci.yml` passes `TURBO_TOKEN` (secret) and `TURBO_TEAM` (variable); `CONTRIBUTING.md`
  says how to create them. A self-hosted cache also needs `TURBO_API` added there.
- §3: not built (Q4); the trigger is recorded in `00-OVERVIEW.md` Q32.
- §4: e2e workflow 19. Running it found Mailpit holding every SMTP greeting for 8 s (a
  reverse-DNS lookup under Docker Desktop), which made each local sign-up, invite and sign-in
  link take 8 s; `docker-compose.yml` now sets `MP_SMTP_DISABLE_RDNS`. The e2e api also blanks
  `MAILGUN_*`, so test runs never send real mail through the account in the root `.env`.

## 1. A separate worker process (optional per deploy)

Today the api process serves HTTP and WebSocket and runs every BullMQ worker (export, email,
validate, import, maintenance, AI doc drafts, drift sweep). One process is fine for most
installs, so the split is **opt-in**:

- `PROCESS_ROLE=all|api|worker`, default `all` (today's behaviour, nothing changes).
- `api`: the `JOB_WORKERS` factory and the `ai-doc-drafts` / `drift` workers return nothing;
  queues are still created so the api can enqueue. Schedulers (`audit.retention`, drift cron)
  are upserted by the worker only.
- `worker`: a new entry, `src/worker.ts` (built to `dist/worker.js` by the existing
  `nest build`, as the CLIs are), uses `NestFactory.createApplicationContext` with the job
  modules only. No HTTP, no gateway, no route sweep. The Docker `runtime` image runs it with
  `CMD ["node", "dist/worker.js"]`; its health check is a Redis ping instead of `/healthz`.
- `docker-compose.yml` gains a `worker` service under a `split` profile; `docs/deploy.md`
  explains when to use it (long exports or imports slowing the api).

### 1.1 The blocker: realtime events from jobs

Jobs reach browsers through in-process RxJS channels: an import commits through `SchemaWriter`
(`commits.results`), AI doc drafts through `DocsService`, export and drift notifications
through `NotificationsService.created`, and `PermissionResolver.accessChanged`. In a separate
process those emits reach no sockets.

Fix: a small **realtime bus**. With `REALTIME_BUS=redis`, each of those four channels publishes
to a Redis pub/sub channel (`sl:rt:<name>`) instead of emitting locally, and every api process
subscribes and feeds the same in-process channel the gateway already reads. Per-socket
redaction is unchanged because it still happens in the process that holds the socket. A Socket.IO
Redis adapter isn't used: it would broadcast already-rendered payloads and skip that redaction.

Side effect, by design: with the bus on, **more than one api replica works**, which
`docs/deploy.md` currently forbids. `PROCESS_ROLE=worker` requires `REALTIME_BUS=redis` (the
env check refuses to boot otherwise).

## 2. Turborepo remote cache in CI (Q33)

`ci.yml` passes `TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}` and `TURBO_TEAM: ${{ vars.TURBO_TEAM }}`
to the turbo steps. Without the secret turbo runs uncached exactly as today, so forks and
local runs are unaffected. The owner creates the token (Vercel Remote Cache, free) and adds
the secret; `CONTRIBUTING`/`docs/deploy.md` says how. A self-hosted cache server works with the
same two variables plus `TURBO_API`.

## 3. Schema-per-worker integration tests (Q32)

The integration suite is **2 files** (`*.int.spec.ts`), run serially. Isolating a Postgres
schema per Vitest worker would save close to nothing today and adds setup that can go wrong.
**Default: don't build it; record the trigger** ("revisit when the suite passes ~15 files or 3
minutes") in `00-OVERVIEW.md` Q32. If the owner wants it anyway: `test/setup` creates
`test_<VITEST_POOL_ID>` schemas from the migrated template and sets `?schema=` per worker, and
`fileParallelism` goes back on.

## 4. Row 15 was built in Phase 3; it needs e2e coverage

Magic link, GitHub OAuth (beside Google), TOTP 2FA, recovery codes and device sessions shipped
in commit `267445f` (2026-09-28), in the api and in Settings → Security. The roadmap still says
`parked`. No e2e covers any of them. **Workflow 19**:

- Magic link: request, read the link from Mailpit's API, sign in.
- TOTP: enrol (code computed in the test from the secret, RFC 6238), sign out, sign in → challenge →
  code → in; a recovery code works once, then not again.
- Sessions: two browser contexts, "Sign out other sessions" in one, the other is signed out on
  its next request.
- OAuth stays unit-tested only (it needs Google/GitHub).

## Open questions

| #   | Question                  | Default                                                                             |
| --- | ------------------------- | ----------------------------------------------------------------------------------- |
| Q1  | Worker split              | **Opt-in** with `PROCESS_ROLE`, default `all`                                       |
| Q2  | Realtime across processes | **Redis pub/sub bus** behind `REALTIME_BUS=redis`; also allows several api replicas |
| Q3  | Remote cache provider     | **Vercel Remote Cache** via `TURBO_TOKEN`/`TURBO_TEAM`; owner adds the secret       |
| Q4  | Schema-per-worker tests   | **Don't build** (2 files); write down when to revisit                               |
| Q5  | Row 15                    | **Mark built**, add e2e workflow 19                                                 |

## Build order

4 (workflow 19, smallest, closes a status error) → 2 (CI cache) → 1 (bus, then worker entry).
