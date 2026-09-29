# SchemaLoom

A visual database design workspace: a schema canvas, per-object docs, and an AI query
assistant that only sees what the user selected and is permitted to see. PostgreSQL in v1,
behind a pluggable engine boundary.

## Working style: ponytail + graphify, always

- **ponytail is on for every session** (project plugin, `full` level). Climb the ladder
  before writing code: reuse what's already here, then stdlib/platform, then the smallest
  diff. No speculative abstractions. Never simplify away permission checks, validation at
  trust boundaries, or data-loss guards.
- **graphify first, grep second.** Orient with `graphify query` / `explain` / `path` (see
  below) before reading or searching source. Include this rule in every subagent prompt
  that explores code.

## Layout

pnpm + turbo monorepo. **Use pnpm, never npm** (`catalog:` and `node-linker=isolated`).

| Path                                         | What                                                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api`                                   | NestJS 11 + Prisma 6 + BullMQ (in-process workers) + S3/MinIO                                                                                                    |
| `apps/web`                                   | Next.js 15 App Router, React Flow canvas, Tailwind                                                                                                               |
| `packages/schema-model`                      | The IR (`SchemaModel`), diff, `logicalKey`, redaction                                                                                                            |
| `packages/engine-sdk`                        | `EngineDefinition`, importer/exporter contracts, registry                                                                                                        |
| `packages/engines/postgresql`                | The only engine; importer uses `libpg-query` (keep it in `dependencies`, or tsup drops the `.wasm`)                                                              |
| `packages/contracts`, `ui`, `config`         | Shared types/atoms, UI kit, tsup/eslint presets                                                                                                                  |
| `e2e`                                        | Playwright workflows 1–6                                                                                                                                         |
| `docs/deploy.md`, `docs/self-host-ubuntu.md` | Production: web and api on ONE hostname behind a proxy (`/api`, `/socket.io` → api), api container (`apps/api/Dockerfile`, `--target migrate`), pinned collation |
| `docs/ROADMAP.md`                            | What's built, what's next and in what order. Check it before starting a feature; update a row's status in the same commit                                        |
| `docs/phase1`                                | The approved design (00-OVERVIEW, 01–05, REVIEW). Read the relevant doc before changing its area                                                                 |

## Commands

```bash
pnpm infra:up          # postgres, redis, minio, mailpit (docker compose)
pnpm dev               # api :3001, web :3000, package watchers
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @schemaloom/api exec prisma migrate deploy   # empty/reset DB
```

E2E: export only `DATABASE_URL_E2E` (sourcing `.env` sets `NODE_ENV=development` and
breaks `next build`). Locally Playwright reuses running dev servers, which point at the
DEV database.

## Rules that are easy to break

- **Every route carries exactly one marker** (`@RequirePermission`, `@RequireProjectAccess`,
  `@RequireOrgRole`, `@Authenticated`, `@Public`). The boot sweep refuses to start
  otherwise, and each controller has a `*.routes.spec.ts` listing its routes.
- **Web and api share one hostname** in every deploy (the api refuses to boot otherwise).
  Session cookies are host-only and RSC pages forward the browser's cookies; two hostnames
  loop on /login. Don't "fix" that by putting `sl_access` on `COOKIE_DOMAIN`.
- **An engine major bump ships `propsUpgrades`** (one step per past major; conformance checks
  it). Projects on the old major stay read-only (`EngineGate.checkWrite`, 423) until an operator
  runs `engine-upgrade.cli.js`. Never convert props on open.
- **Invisible is 404, not 403.** Don't make a route an existence oracle.
- **Only org owners see every project (R13, amended 2026-09-29).** Org admins manage the org
  but see only projects they are granted, like members. Don't reintroduce `'admin'` into a
  project-visibility check.
- **All schema data leaves through `VisibilityFilter`**. `LiveIr` (unredacted) never
  leaves `src/snapshots`. All schema writes go through `SchemaWriter`; there is no second
  mutation path.
- Skeleton-changing writes bump `permGeneration`. Code that writes across several batches
  must re-resolve the map and skeleton between batches.
- No engine id is hard-coded in `apps/web`; engines come from `GET /engines`.
- SQL import merges additively (existing objects win, nothing deleted). Changing that is a
  product decision; ask first.
- Phase 3 owns custom roles, `email_invite` grants (R11), guest accounts, and extra login
  paths (magic link, 2nd OAuth, TOTP, recovery codes). See `docs/phase1/00-OVERVIEW.md`,
  "Deferred to Phases 2–5".
- Write in English. Git commits go on `main` only when the user asks.
- Every commit message ends with `Co-Authored-By: Kasra Karami <kasra_k2k@yahoo.com>`, and no
  other co-author line.

## Windows gotchas

- Stopping a background `pnpm dev` leaves `node` children alive. They hold 3000/3001 and
  lock Prisma's `query_engine-windows.dll.node` (`EBUSY` on the next start). Kill every
  `node.exe` whose command line contains `SchemaLoom`, then confirm with `netstat -ano`.
- `localhost:5432` is ambiguous here: `[::1]` reaches a second Postgres through WSL.
  `.env` pins `POSTGRES_HOST=127.0.0.1` (Docker). "Something went wrong on our side" on
  sign-in/sign-up usually means an unmigrated DB, so check `prisma migrate status`.
- `docker compose down -v` deletes the database volume.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:

- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
- The graph is gitignored. The post-commit/post-checkout hooks (`graphify hook install`) rebuild it; on a fresh clone run `graphify update .` once.
