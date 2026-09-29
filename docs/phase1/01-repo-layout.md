# 01 — Repository layout, workspace graph and tooling

**Status:** design proposal, Phase 1. No source files exist yet; everything below is
what gets created after this document is approved.

**Scope of this document:** the monorepo shape, the workspace dependency graph, the
build/test tooling, local infrastructure, and the environment contract. It does *not*
define the Prisma schema (doc 02), the engine interfaces (doc 03), the IR types
(doc 04) or the permission algorithm (doc 05) — it only fixes *where those live and
what may import what*.

**Conventions honoured:** C10 (package boundaries) is the spine of this document.
C12 (smallest design) drove every "skipped" note.

---

## 1. Top-level tree

```
schemaloom/
├─ .github/
│  └─ workflows/ci.yml            three jobs: static, integration, e2e — specified in §8.3
├─ .vscode/
│  ├─ extensions.json             eslint, prisma, tailwind
│  └─ settings.json               format-on-save, eslint flat-config, TS SDK = workspace
├─ apps/
│  ├─ api/                        NestJS backend (the only thing that talks to Postgres)
│  └─ web/                        Next.js App Router frontend
├─ packages/
│  ├─ schema-model/               engine-neutral IR types + diff. Depends on zod only.
│  ├─ engine-sdk/                 EngineDefinition + EngineUiPlugin + conformance suite
│  ├─ contracts/                  zod request/response schemas, DTO types, permission atoms
│  ├─ engines/
│  │  ├─ postgresql/              PostgreSQL EngineDefinition (server) + static descriptor
│  │  └─ postgresql-ui/           PostgreSQL EngineUiPlugin (React)
│  ├─ ui/                         Radix + Tailwind component library
│  └─ config/                     tsconfig / eslint / tailwind / tsup / vitest presets
├─ e2e/                           Playwright suite that drives web+api together
├─ docs/
│  └─ phase1/                     these design documents
├─ .env.example                   committed; `.env` is the single file a dev edits
├─ .gitattributes                 `* text=auto eol=lf` — see below
├─ .gitignore
├─ .npmrc
├─ .nvmrc                         22
├─ docker-compose.yml             postgres / redis / minio / mailpit
├─ eslint.config.js               flat config, re-exports packages/config/eslint
├─ package.json                   private root, scripts are thin turbo wrappers
├─ pnpm-workspace.yaml
├─ prettier.config.mjs
├─ turbo.json
└─ README.md
```

**Why these boundaries and not fewer:**

- `schema-model` is split from `contracts` because the IR is *domain* (it has no HTTP
  shape and no notion of a request) while `contracts` is *transport*. Merging them
  would drag pagination/error envelopes into `engine-sdk`'s dependency closure and
  break C10's "schema-model depends on nothing but zod".
- `engines/` is a nested folder, not `packages/engine-postgresql`, so that adding
  MySQL later is visibly a drop-in sibling and the workspace glob (`packages/engines/*`)
  already covers it.
- `config` is not a build target — it ships JSON and JS presets verbatim, so it has no
  `dist/` and no `build` script.
- `e2e` is its own workspace package rather than living in `apps/web`, because the
  suite exercises web *and* api and belongs to neither. This is an *ownership* choice,
  not a tooling limit: Turborepo expresses a cross-app task dependency fine, and §8.2
  writes it out explicitly (`test:e2e` dependsOn `@schemaloom/api#build` and
  `@schemaloom/web#build`).

`.gitattributes` exists because Windows is the primary dev platform (§10) and the repo
ships Prettier with format-on-save: without it `core.autocrlf` differs per developer,
Prettier rewrites whole files, and Turborepo's input hashes churn.

```gitattributes
* text=auto eol=lf
*.sh  text eol=lf
*.ps1 text eol=crlf
*.png binary
*.jpg binary
*.woff2 binary
pnpm-lock.yaml -diff linguist-generated
```

`prettier.config.mjs` sets `endOfLine: 'lf'` to match.

**Not created in Phase 1** (see §12): no `packages/engines/mysql`, no
`apps/worker` (BullMQ processors run in the api process for now — see Open questions),
no `packages/emails` (React Email templates live in `apps/api/src/mail/templates`
until there are more than ~8 of them), no changesets/versioning setup (every package
is `"private": true`, `"version": "0.0.0"`, consumed via `workspace:*`; nothing is
published to npm, so versioning is dead weight).

---

## 2. Workspace inventory

Every package a file imports **must be a direct dependency of that package**. Under
`node-linker=isolated` (§8.1) there is no transitive availability: if `apps/api`
imports `@schemaloom/schema-model` because it arrived via `engine-postgresql`, the
import fails to resolve. The "Workspace deps" column below is therefore the complete
set, not a summary.

| Path | Package name | Build | Workspace deps | Runtime deps (external) | Consumed by |
|---|---|---|---|---|---|
| `apps/api` | `@schemaloom/api` | `nest build` | schema-model, contracts, engine-sdk, engine-postgresql | nest, prisma, nestjs-zod, ioredis, bullmq, argon2, passport, pino, zod, @aws-sdk/client-s3, resend, nodemailer, sharp (avatar resize) | — |
| `apps/web` | `@schemaloom/web` | `next build` | schema-model, contracts, engine-sdk (`/ui` only), engine-postgresql (`/static` only), engine-postgresql-ui, ui | next, react, @xyflow/react, elkjs, html-to-image, @tanstack/react-query, zustand, tiptap, codemirror, react-hook-form, zod | — |
| `packages/schema-model` | `@schemaloom/schema-model` | tsup | — | `zod` | engine-sdk, contracts, api, web |
| `packages/engine-sdk` | `@schemaloom/engine-sdk` | tsup | schema-model | `zod` (+ `react` as an **optional peer**, `/ui` only) | engines, api, web |
| `packages/contracts` | `@schemaloom/contracts` | tsup | schema-model | `zod` | api, web, e2e |
| `packages/engines/postgresql` | `@schemaloom/engine-postgresql` | tsup | engine-sdk, schema-model | `zod`, `libpg-query` (dynamic import, server only) | api, (`/static` only) web + postgresql-ui |
| `packages/engines/postgresql-ui` | `@schemaloom/engine-postgresql-ui` | tsup | engine-sdk (`/ui`), engine-postgresql (`/static`), schema-model, ui | react, @xyflow/react | web |
| `packages/ui` | `@schemaloom/ui` | tsup | — | react, @radix-ui/react-*, cva, tailwind-merge, lucide-react | web, postgresql-ui |
| `packages/config` | `@schemaloom/config` | — (JS/JSON only, §6) | — | — | everything, as a devDependency |
| `e2e` | `@schemaloom/e2e` | — | contracts (payload types for seeding) | `@playwright/test` | — |

`sharp` is listed because `UsersModule` resizes uploaded avatars before the presigned
PUT; it is the only native image dependency and the reason `sharp` appears in
`onlyBuiltDependencies` (§8.1). `elkjs` is the canvas auto-layout engine (spec §6.1)
and `html-to-image` produces the SVG/PNG diagram export client-side (§4, TransferModule).

---

## 3. `apps/api` — directory tree

```
apps/api/
├─ prisma/
│  ├─ schema.prisma               single file in Phase 1; split by `prismaSchemaFolder` if it passes ~800 lines
│  ├─ migrations/                 checked in
│  └─ seed.ts                     demo org, one user per org role, sample e-commerce schema
├─ src/
│  ├─ main.ts                     bootstrap: helmet, cookie-parser, CORS allow-list, CSRF middleware,
│  │                              global ZodValidationPipe/filter, patchNestJsSwagger() + Swagger, pino
│  ├─ app.module.ts               composition root; registers APP_GUARD ×2 / APP_FILTER / APP_INTERCEPTOR
│  ├─ config/
│  │  ├─ env.ts                   zod schema for every API env var (§11.1)
│  │  └─ config.module.ts         ConfigModule.forRoot({ isGlobal, envFilePath, validate })
│  ├─ common/
│  │  ├─ decorators/              @Public, @CurrentUser, @RequirePermission
│  │  ├─ filters/                 AllExceptionsFilter → RFC7807-ish error envelope from contracts
│  │  ├─ interceptors/            request-id only
│  │  ├─ pipes/                   ZodValidationPipe (nestjs-zod, over packages/contracts schemas)
│  │  ├─ csrf/                    double-submit middleware + `sl_csrf` issuance helper (§4)
│  │  └─ logger/                  pino config, redaction list (cookies, tokens, password)
│  ├─ prisma/                     PrismaModule (@Global) + PrismaService (onModuleInit connect, shutdown hook)
│  ├─ redis/                      RedisModule (@Global) + ioredis factory → three clients (§4)
│  ├─ health/                     /healthz (liveness), /readyz (db+redis+s3 ping)
│  ├─ auth/                       see §4
│  ├─ users/
│  ├─ orgs/
│  ├─ workspaces/
│  ├─ projects/
│  ├─ schema/
│  ├─ docs/
│  ├─ engines/                    EnginesModule + engines.manifest.ts + coming-soon.const.ts (§4)
│  ├─ access/
│  ├─ transfer/
│  ├─ mail/
│  ├─ storage/
│  ├─ jobs/
│  ├─ audit/
│  └─ generated/prisma/           gitignored; Prisma client output (see §8)
├─ test/
│  ├─ integration/                *.int.spec.ts — real Postgres + Redis (§12 isolation rule)
│  └─ setup/                      global setup: create/migrate `schemaloom_test`, truncate per test
├─ nest-cli.json
├─ tsconfig.json
├─ tsconfig.build.json
├─ vitest.config.ts               unit
├─ vitest.integration.config.ts   integration
└─ package.json
```

Every module folder has the same internal shape — no per-module invention:

```
<module>/
├─ <module>.module.ts
├─ <module>.controller.ts         (+ more controllers when routes exceed ~10)
├─ <module>.service.ts
├─ dto/                           createZodDto() wrappers over @schemaloom/contracts schemas
└─ *.spec.ts                      co-located unit tests
```

### 3.1 One source of truth for every request/response shape

Spec §2 wants both "OpenAPI/Swagger generated from decorators" and shared zod schemas
from `packages/contracts`. Writing a zod schema *and* a decorated Swagger class is two
definitions of the same shape, and the published OpenAPI document drifts from what the
API actually accepts. **`nestjs-zod` removes the second definition:**

```ts
// apps/api/src/projects/dto/create-project.dto.ts
import { createZodDto } from 'nestjs-zod';
import { CreateProjectBody } from '@schemaloom/contracts';

export class CreateProjectDto extends createZodDto(CreateProjectBody) {}
```

- `createZodDto()` produces the class Nest needs for DI, the `@Body()` type and
  `@ApiBody({ type: … })`.
- `patchNestJsSwagger()` is called once in `main.ts` **before** `SwaggerModule.setup`,
  so `@nestjs/swagger` derives the schema from the same zod object.
- The global `ZodValidationPipe` validates against that same object.

So `dto/` is one three-line file per shape, and the only place a shape is *defined* is
`packages/contracts`. `nestjs-zod` is the only reason `apps/api` needs a zod-Swagger
bridge; it is listed in §2.

---

## 4. NestJS module list

| Module | Responsibility (one line) | Needs `EnginesModule` | Needs `AccessModule` |
|---|---|---|---|
| `AppModule` | Composition root; wires global guard, filter, interceptor. | — | — |
| `ConfigModule` *(global)* | Parses and validates `process.env` once at boot; exposes typed config. | — | — |
| `PrismaModule` *(global)* | Owns the `PrismaClient` lifecycle and transaction helper. | — | — |
| `RedisModule` *(global)* | One ioredis factory, **three distinct clients** — see below. | — | — |
| `HealthModule` | Liveness/readiness probes and build metadata. | — | — |
| `EnginesModule` *(global)* | Wraps the SDK's `createEngineRegistry()` as a Nest provider, fed from the `ENGINE_DEFINITION` multi-token; serves `GET /engines`. | *is* | — |
| `AccessModule` *(global)* | `PermissionResolver`, `PermissionGuard`, `VisibilityFilter`, grant CRUD, membership/org-role reads, Redis-cached effective permissions. | — | *is* |
| `AuthModule` | Credentials, tokens and sessions **only**: password/magic-link/OAuth login, JWT access + rotating refresh cookies, reuse detection, email verification, password reset, TOTP 2FA, device session list, `sl_csrf` issuance. | no | **yes** — every membership or org-role read goes through `AccessModule`. |
| `UsersModule` | Profile, avatar upload (sharp resize → presigned PUT), theme preference, notification preferences row. | no | no |
| `OrgsModule` | Organizations, org members and org roles, member invites, user groups + group members. | no | yes (org-role checks reuse the resolver) |
| `WorkspacesModule` | Workspaces inside an org; rename, archive, list. | no | yes |
| `ProjectsModule` | Projects (`engineId`, `engineVersion`, `settings`), Areas, Namespaces. Validates `engineId` against the registry on create. | yes | yes |
| `SchemaModule` | Entities, fields, links, indexes, constraints, custom types; assembles the IR from relational rows; optimistic-concurrency writes (C7). | yes | yes |
| `DocsModule` | TipTap doc rows for entity/field/link targets, structured field docs, coverage meter. | no | yes |
| `TransferModule` | DDL/JSON import (preview → apply, with an unsupported-statement report); server-side DDL / JSON / Markdown export; receives client-rendered SVG/PNG uploads. See §4.3. | yes | yes |
| `MailModule` | `EmailProvider` interface + Resend and SMTP implementations; renders templates. | no | no |
| `StorageModule` | S3/MinIO client, presigned PUT/GET, `ensureBucket()` on boot. | no | no |
| `JobsModule` | BullMQ queue + processor registration (Phase 1: export rendering, email send, DDL import apply). | no | no |
| `AuditModule` | Append-only writers for `activity_log` (user-visible) and `audit_log` (security). | no | no |

`EnginesModule` and `AccessModule` are `@Global()` precisely because the alternative is
importing them into eight modules; the spec's "all other modules call the registry"
is the definition of a global provider. `AccessModule` does **not** import
`AuthModule` — the resolver takes an already-established principal, never a request —
so `AuthModule → AccessModule` creates no cycle.

### 4.1 The guard chain — two guards, one order, one default

Two `APP_GUARD`s, registered in `app.module.ts` in this order (Nest runs global guards
in registration order):

| # | Guard | Honours | Rejects with |
|---|---|---|---|
| 1 | `JwtAuthGuard` | `@Public()` | 401 — no valid access token / share-link session |
| 2 | `PermissionGuard` | `@Public()`, `@Authenticated()`, `@RequirePermission(atom, locator)`, `@RequireProjectAccess(param)`, `@RequireOrgRole(param, roles)` | 403, or **404** when the subject cannot see the resource at all |

**There is no implicit default for an undecorated route.** An earlier draft said an
undecorated non-public route meant "authenticated + org membership"; that is
indistinguishable from "someone forgot a decorator", which is exactly what the boot sweep
exists to catch. Every route carries exactly one of **five** markers, and
`GET /users/me`-style routes that name no resource carry `@Authenticated()` explicitly.
Doc 05 §10 owns the decorators and the guard algorithm; this section owns where they are
registered and what fails the build.

**The boot-time route sweep is mandatory and covers two questions.**
`AppModule.onApplicationBootstrap()` walks the Nest route table and throws unless **every**
route under `/api/**`:

1. carries exactly one of `@Public()`, `@Authenticated()`, `@RequirePermission`,
   `@RequireProjectAccess` or `@RequireOrgRole`; **and**
2. is classified against doc 05's `SHARE_LINK_ROUTES` allow-list (R21) — reachable by a
   share-link subject, or not.

A missing or ambiguous marker fails the process on startup and in the `test:int` boot test,
which is what makes "every route protected by guards" (spec §10) structural rather than a
review checklist. The second question matters just as much: `schema:view` is a deliberately
fat atom, so a new surface built on it would be a public-link leak by default.

**Resource resolution.** `@RequirePermission` supplies `(atom, locator)` — doc 05 §10.1's
signature, e.g. `@RequirePermission('schema:edit', { entity: 'id' })`, where the locator
names a route param by default and may be prefixed `body.` or `query.` to look elsewhere.
For ids that are not themselves a project id, the guard resolves the owning project from
the request-scoped `ResourceIndex` (built from the cached permission skeleton), falling back
to a single indexed `SELECT project_id` — the denormalized column C6 mandates, never a join.
The resolver's own Redis cache (below) absorbs the repeat cost.

**The schema write path is one route, not per-object REST.** Doc 04 §8.2 makes
`POST /projects/:projectId/schema/ops` the only write endpoint for the schema domain
(plus `…/schema/geometry` and the docs endpoint). It is annotated
`@RequireProjectAccess('projectId')`, and per-operation authorisation happens **inside** the
service: `requirementsOf(op, live)` (doc 04 §8.5) produces a set of
`(atom, resource)` requirements per op, and `resolver.assertAll(...)` checks them
all-or-nothing against the one already-resolved permission map. Guards never loop, and a
partially-applied batch is impossible.

### 4.2 Engine registration — the one seam that must not be retrofitted

Spec §3.2: *"Engines register themselves at startup… Adding a new engine = add a
package + register it. No changes to core modules."* Literal self-registration needs a
side-effecting import, which is invisible, order-dependent and gets tree-shaken. The
substitute, and the exact shape:

```ts
// apps/api/src/engines/engines.manifest.ts   ← the ONLY file that names a concrete engine
import { postgresEngine } from '@schemaloom/engine-postgresql';
import type { EngineDefinition } from '@schemaloom/engine-sdk';

export const ENGINE_MANIFEST: EngineDefinition[] = [postgresEngine];
```

```ts
// apps/api/src/engines/engines.module.ts      ← core; contains no engine name
import { createEngineRegistry } from '@schemaloom/engine-sdk';
import { ENGINE_MANIFEST } from './engines.manifest';
import { COMING_SOON } from './coming-soon.const';

export const ENGINE_DEFINITION = Symbol('ENGINE_DEFINITION');
export const ENGINE_REGISTRY = Symbol('ENGINE_REGISTRY');

@Global()
@Module({
  providers: [
    ...ENGINE_MANIFEST.map((engine) => ({
      provide: ENGINE_DEFINITION,
      useValue: engine,
      multi: true,
    })),
    {
      provide: ENGINE_REGISTRY,
      inject: [ENGINE_DEFINITION],
      useFactory: (engines: EngineDefinition[]) => {
        // doc 03 §14: the registry is constructed from the ANNOUNCED list and derives
        // "coming soon" by set difference, so a registration always wins and shipping an
        // engine needs no edit to the announcement.
        const registry = createEngineRegistry(COMING_SOON);
        for (const engine of engines) registry.register(engine);
        return registry;
      },
    },
  ],
  controllers: [EnginesController],
  exports: [ENGINE_REGISTRY],
})
export class EnginesModule {}
```

- `EngineRegistry` **is** `createEngineRegistry(announced)` from `@schemaloom/engine-sdk`
  (§6, doc 03 §14), wrapped by exactly one Nest provider. There is no Nest-native
  reimplementation of the registry, so the framework-free version in the SDK stays the single
  implementation.
- Adding MySQL is: `pnpm add @schemaloom/engine-mysql` + one line in
  `engines.manifest.ts`. No file under `access/`, `schema/`, `projects/`, `transfer/`
  or `engines/engines.module.ts` changes.
- `ProjectsModule` validates `engineId` against `EngineRegistry` on project create;
  an unknown id is a 400, never a row.

**Deviation from the spec, stated loudly** (C12 requires this rather than silence):
"engines register themselves" is not literally implemented. One manifest file lists
them. See Open question 2.

**`GET /engines` and the "Coming soon" picker.** Spec §7 wants unimplemented engines
shown as coming-soon "driven by the registry, not hard-coded" — but a registry by
construction holds only engines that exist as packages. Resolved here so two
implementers cannot ship two answers:

```ts
// apps/api/src/engines/coming-soon.const.ts
// The rows are doc 03's `AnnouncedEngine` — the picker card needs an icon and a one-line
// summary, so those two fields are part of the shape rather than invented in a component.
import type { AnnouncedEngine } from '@schemaloom/engine-sdk';

export const COMING_SOON: readonly AnnouncedEngine[] = [
  { id: 'mysql',     displayName: 'MySQL',      paradigm: 'relational',  icon: 'database', summary: 'MySQL 8 and MariaDB' },
  { id: 'sqlserver', displayName: 'SQL Server', paradigm: 'relational',  icon: 'database', summary: 'Microsoft SQL Server 2019+' },
  { id: 'sqlite',    displayName: 'SQLite',     paradigm: 'relational',  icon: 'database', summary: 'Embedded SQL' },
  { id: 'mongodb',   displayName: 'MongoDB',    paradigm: 'document',    icon: 'leaf',     summary: 'Collections and documents' },
  { id: 'dynamodb',  displayName: 'DynamoDB',   paradigm: 'key-value',   icon: 'zap',      summary: 'AWS key-value and document store' },
  { id: 'cassandra', displayName: 'Cassandra',  paradigm: 'wide-column', icon: 'columns',  summary: 'Wide-column store' },
  { id: 'neo4j',     displayName: 'Neo4j',      paradigm: 'graph',       icon: 'share-2',  summary: 'Nodes and relationships' },
];
```

`GET /engines` returns `registry.catalog()`, which is doc 03's
`{ available: EngineDescriptor[], comingSoon: AnnouncedEngine[] }`. The list lives
**server-side, in `EnginesModule`** — not in a React component, not in `engine-sdk`, and not
as a `status` field on `EngineDefinition` (doc 03 does not have one). Status is derived by
set difference inside `catalog()`: a registration always wins over an announcement, so when
an engine package lands, adding one line to `ENGINE_MANIFEST` is enough and deleting its
`COMING_SOON` row is optional tidying. The picker is untouched either way.

### 4.3 Export: what is rendered where

Spec §6.4 lists five export formats. The diagram lives in React Flow in the browser and
the server has no layout for it, so the split is:

| Format | Where | How |
|---|---|---|
| PostgreSQL DDL | server (`TransferModule` → engine `exporter`) | Phase 1 |
| JSON (the IR) | server (`VisibilityFilter` → IR serialise) | Phase 1 |
| Documentation as Markdown | server (`DocsModule` rows → Markdown) | Phase 1 |
| SVG + PNG of the diagram | **client** (`html-to-image` over the live React Flow graph), uploaded to S3 via a presigned PUT from `StorageModule`, then linked like any other export artifact | Phase 1 |
| | *The presigned PUT is minted per `export_jobs` row, for that one object key, with a short expiry, and only after the same `export:run` check the server-side formats run — so the upload surface is not a general-purpose bucket write. The rendered image is redacted by construction: the client only ever holds the redacted model (doc 05 §8), so the canvas it rasterises cannot contain what the user may not see.* | |
| Documentation as PDF | **deferred to Phase 5** with docs mode | see §13 |

Consequence worth stating in a repo-layout document: **`apps/api` has no headless
browser and no rasteriser.** Puppeteer/Playwright-in-the-API is a large,
security-relevant dependency that the client-side render makes unnecessary. PDF is
deferred rather than dropped: when it lands it is Markdown → PDF in the API, which does
not need a browser either.

### 4.4 `RedisModule` — three clients, one instance, TTL on everything

BullMQ cannot share a connection with ordinary commands: it issues blocking reads
(`BZPOPMIN`, `BRPOPLPUSH`) that stall every other command queued on the same socket,
and it requires `maxRetriesPerRequest: null`, which is exactly wrong for a cache
client. So `RedisModule` exposes **three distinct ioredis instances from one factory**,
under three injection tokens:

| Token | Options | Key prefix | Used by |
|---|---|---|---|
| `REDIS_CACHE` | defaults | `${REDIS_KEY_PREFIX}cache:` | `PermissionResolver` effective-permission cache |
| `REDIS_RATELIMIT` | defaults | `${REDIS_KEY_PREFIX}rl:` | rate limiter |
| `REDIS_QUEUE` | `maxRetriesPerRequest: null`, `enableReadyCheck: false` | `${REDIS_KEY_PREFIX}q:` | BullMQ (Phase 4: Socket.IO adapter) |

Three rules that go with them, all of which were previously implicit:

1. **Every cache and rate-limit key is written with an explicit TTL** — permission map
   entries at `min(300 s, validUntil − now)` and the permission skeleton at 600 s (doc 05
   §9.1 derives both; 300 s is the cap, not the constant, because an expiring share link
   must not leave a 300-second map behind it), rate-limit counters at
   `EX RATE_LIMIT_WINDOW_SEC`. No exceptions.
   This is what makes `--maxmemory-policy noeviction` (§10) safe: the permission cache
   is one entry per (principal, resource) pair and would otherwise grow without bound
   until Redis started rejecting *writes* — including queue writes and rate-limit
   writes — on the one instance that carries the queues. `noeviction` protects the
   queue; TTLs protect `noeviction`.
2. **The rate limiter fails closed.** A Redis error on the counter path returns 503,
   not "allow". Failing open on the exact resource the spec wants throttled is not an
   acceptable default.
3. **`REDIS_KEY_PREFIX` is mandatory and environment-derived** (`sl:` in dev,
   `sl-test:` under `test:int`, `sl-e2e:` under `test:e2e`), so isolation between a
   developer's running `pnpm dev` api and a test run holds even if both point at the
   same logical DB. §11.1 also gives `test:int` its own `REDIS_URL_TEST` on DB 1; the
   prefix is the belt to that suspenders.

### 4.5 CSRF — owner, cookie, and who checks it

Cookie auth needs CSRF (spec §10) and `SameSite=Lax` alone does not cover the
`POST`/`PATCH`/`DELETE` surface here. Ownership, previously a dangling env var:

- **Issued by** `AuthModule` on login/refresh: a `sl_csrf` cookie holding a random
  token HMAC'd with `CSRF_SECRET`. It is **non-httpOnly by design** (the SPA must read
  it) and carries `Domain=${COOKIE_DOMAIN}` so `app.schemaloom.dev` can read a cookie
  set by `api.schemaloom.dev`. It carries no authority on its own — possession of it
  proves nothing without the httpOnly session cookie.
- **Verified by** a global middleware in `apps/api/src/common/csrf/`, mounted in
  `main.ts`, on every unsafe method (`POST`, `PUT`, `PATCH`, `DELETE`). It compares the
  `X-CSRF-Token` header against the cookie and the HMAC.
- **Exempt:** `@Public()` routes (they carry no cookie authority) and `GET`/`HEAD`,
  including the SSE stream. **Share-link sessions are not an exemption**: `sl_session` is a
  cookie, so it would be as forgeable cross-site as any other. They need no exemption either,
  because doc 05's `SHARE_LINK_ROUTES` allow-list contains only `GET` routes and the socket
  subscribe — a share-link subject has no unsafe method to protect. The one route that is
  both unsafe and unauthenticated, `POST /s/:token/unlock`, is `@Public()` and is protected by
  its own per-IP and per-link rate limits instead.
- **Sent by** `apps/web/src/lib/api-client.ts`, which reads `sl_csrf` and sets
  `X-CSRF-Token` on every non-GET request. One place, not per call site.

**Deferred modules** (folder not created in Phase 1): `AiModule` (P2),
`RealtimeModule` Socket.IO gateway (P4), `CommentsModule` (P4), `HistoryModule`
snapshots/diff/migrations (P4), `NotificationsModule` (P4), `SearchModule` (P5).

---

## 5. `apps/web` — directory tree and App Router structure

```
apps/web/
├─ public/
│  └─ fonts/                      self-hosted Inter + JetBrains Mono (next/font/local)
├─ src/
│  ├─ app/
│  │  ├─ layout.tsx               <html>; reads theme cookie server-side to avoid FOUC; fonts; Providers
│  │  ├─ globals.css              @import tailwindcss; @import @schemaloom/config/tailwind/theme.css; @source
│  │  ├─ error.tsx, not-found.tsx
│  │  ├─ page.tsx                 redirect → /login or last org
│  │  ├─ (auth)/
│  │  │  ├─ layout.tsx            centred card, no shell, no session fetch
│  │  │  ├─ login/page.tsx
│  │  │  ├─ signup/page.tsx
│  │  │  ├─ forgot-password/page.tsx
│  │  │  ├─ reset-password/page.tsx
│  │  │  ├─ verify-email/page.tsx
│  │  │  ├─ magic-link/page.tsx        consumes ?token, POSTs to api, redirects
│  │  │  ├─ two-factor/page.tsx
│  │  │  └─ invite/[token]/page.tsx    log in or sign up, then land on the shared resource
│  │  └─ (app)/
│  │     ├─ layout.tsx            SERVER: fetch session + org list; renders <AppShell> + <Providers>
│  │     ├─ account/
│  │     │  ├─ profile/page.tsx
│  │     │  ├─ sessions/page.tsx
│  │     │  └─ security/page.tsx        password, 2FA enrol, recovery codes
│  │     └─ [orgSlug]/
│  │        ├─ page.tsx                 workspace overview
│  │        ├─ settings/
│  │        │  ├─ general/page.tsx
│  │        │  ├─ members/page.tsx
│  │        │  └─ groups/page.tsx       Phase 3 — route created, renders "coming soon" stub
│  │        ├─ w/[workspaceSlug]/page.tsx   project list + create-project dialog (engine picker)
│  │        └─ p/[projectId]/
│  │           ├─ layout.tsx            SERVER: project meta + engine descriptor ONLY (§5.2)
│  │           ├─ page.tsx              SERVER shell: prefetch+dehydrate the IR query → <CanvasView /> (client, ssr:false)
│  │           └─ settings/page.tsx
│  ├─ components/
│  │  ├─ app-shell/               sidebar, topbar, presence slot, command-palette mount
│  │  └─ providers.tsx            'use client': QueryClientProvider, ThemeProvider, TooltipProvider, EngineUiProvider, Toaster
│  ├─ features/
│  │  ├─ canvas/                  React Flow graph, nodes, edges, minimap, lasso, auto-layout (elkjs)
│  │  ├─ inspector/               right-hand context panel (entity / field / link / docs tabs)
│  │  ├─ docs-panel/              TipTap editor + structured field-doc form
│  │  ├─ transfer/                import wizard, export dialog
│  │  ├─ projects/                project list, create dialog, engine picker
│  │  └─ auth/                    forms shared across (auth) routes
│  ├─ engines/
│  │  ├─ registry.ts              one line: createEngineUiRegistry() from @schemaloom/engine-sdk/ui
│  │  ├─ register.ts              'use client': imports @schemaloom/engine-postgresql-ui and registers it
│  │  └─ use-engine-ui.ts         hook: current project's engineId → plugin (+ capability gating helpers)
│  ├─ lib/
│  │  ├─ api-client.ts            typed fetch wrapper: credentials:'include', error envelope → typed error
│  │  ├─ server-api.ts            server-component variant that forwards the incoming Cookie header
│  │  ├─ query-client.ts
│  │  └─ theme.ts
│  ├─ stores/
│  │  └─ canvas-store.ts          Zustand: selection, viewport, drag state, undo/redo stack
│  ├─ env.client.ts               NEXT_PUBLIC_* schema; the only env module next.config.ts imports
│  ├─ env.ts                      server env schema, parsed lazily on first access (§11.4)
│  └─ middleware.ts
├─ next.config.ts
├─ postcss.config.mjs             { plugins: { '@tailwindcss/postcss': {} } }
├─ tsconfig.json
├─ vitest.config.ts
└─ package.json
```

### 5.1 Route groups — why three

- `(auth)` — unauthenticated, no shell, no session fetch. A separate group so its
  layout does not pay for the app shell's data fetch.
- `(app)` — the authenticated shell (sidebar / topbar / right panel). Its `layout.tsx`
  is the single place a session is fetched server-side.
- `(share)` — public, read-only share-link viewer. **Not created in Phase 1** (share
  links are Phase 3). Reserved here so nobody puts `/s/[token]` inside `(app)` later
  and inherits an authenticated layout.

No `(marketing)` group in Phase 1: `/` is a redirect. Add the group when there is a
landing page to put in it.

### 5.2 Server vs client boundary for the canvas

| Piece | Kind | Why |
|---|---|---|
| `(app)/layout.tsx`, `[orgSlug]/…/layout.tsx` | Server | Session + project metadata fetched with the forwarded cookie; no client waterfall on first paint. |
| `p/[projectId]/layout.tsx` | Server | **Project meta + engine descriptor only.** Small, stable, needed by every child route including `/settings`. It does **not** fetch the IR. |
| `p/[projectId]/page.tsx` | Server | Prefetches the IR query and dehydrates **only that query** into a `HydrationBoundary` scoped to this route, then renders the client canvas. |
| `<CanvasView>` | Client, `dynamic(..., { ssr: false })` | React Flow measures the DOM; SSR output is discarded on hydration and costs a full render of 300+ nodes. |
| Nodes, edges, inspector, TipTap, CodeMirror, command palette, toasts | Client | All stateful/DOM-bound. |
| Sidebar lists | Server component shell + client list for filter/reorder | Initial data server-rendered, interaction client-side. |
| Mutations | Client, TanStack Query → API directly | **No Next Server Actions.** The API is the source of truth and already owns auth, validation and permissions; a server action would add a second hop and a second place to re-implement the guard. |

**Why the IR moved out of the layout.** The spec targets 300+ entities at ~15 fields
each plus indexes, constraints, links and doc pointers. Dehydrating that into the
*layout* serialises a multi-megabyte object into the RSC flight payload and inlines it
in the HTML: it blocks first paint, cannot stream, is re-sent on every layout
re-render, is paid in full by a user who navigated to `/settings`, and puts
`SchemaModule`'s relational→IR assembly on the synchronous server-render path of every
navigation (which is where the first N+1 will show up). The redaction property this was
protecting is unaffected — `VisibilityFilter` runs server-side whether the caller is an
RSC or the browser, so the client never sees a pre-redaction payload either way.

Fetching it as its own query at the canvas route keeps first paint fast, lets the query
cache independently of navigation, and leaves room to make the fetch incremental
(per-viewport or per-area) later without touching the route tree.

**Must be measured before Phase 1 closes:** the serialised size and server assembly
time of the redacted IR for a 300-entity project. If it exceeds ~1 MB gzipped, the
canvas query becomes paginated by area before the canvas ships, not after.

### 5.3 Where `EngineUiRegistry` is initialised

The registry **shape** is part of the engine contract, not app code (spec §3.3), so it
lives in the SDK next to its backend twin: `createEngineUiRegistry()` is exported from
`@schemaloom/engine-sdk/ui` (§6). An engine author reads one package to learn both
halves of the contract and never has to open the web app.

`apps/web/src/engines/registry.ts` is therefore one line:

```ts
// src/engines/registry.ts
import { createEngineUiRegistry } from '@schemaloom/engine-sdk/ui';

export const engineUiRegistry = createEngineUiRegistry();
```

`src/engines/register.ts` is a `'use client'` module whose top-level body performs the
one registration:

```ts
// src/engines/register.ts
'use client';
import { postgresEngineUi } from '@schemaloom/engine-postgresql-ui';
import { engineUiRegistry } from './registry';

engineUiRegistry.register(postgresEngineUi);
```

It is imported exactly once, from `components/providers.tsx` (`EngineUiProvider`), so
registration happens before any canvas renders and never during a server render.
Phase 1 uses a static import because there is one engine; when engine #2 lands,
`register.ts` becomes a `Record<engineId, () => Promise<EngineUiPlugin>>` of
`dynamic()` loaders and the provider awaits the current project's engine. That change
is local to this one file — which is the whole point of the registry.

*Registry with one entry is by definition an abstraction with one implementation; the
spec explicitly demands this seam (§3.3), so C12's exception applies.*

### 5.4 Middleware vs API — responsibility split

`src/middleware.ts` does exactly one thing: **cheap presence-based redirects.**

```ts
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|fonts|.*\\.(?:svg|png|webp)$).*)'],
};
```

| Middleware (edge) | API (`PermissionGuard` + `VisibilityFilter`) |
|---|---|
| Is the **`sl_presence`** cookie present? If not → `307 /login?next=<path>` | Is the access token valid, unexpired, unrevoked? |
| Is the user on `/login` *with* that cookie → `307` to the app | Who is the user, which orgs, which role? |
| Nothing else | Every resource permission, every field-level redaction, every rate limit |

Middleware never verifies a signature (no JWT secret at the edge, and the API rotates
refresh tokens), never fetches, never reads a body. A forged cookie gets you an app
shell whose first request 401s and bounces you to `/login`. This keeps the rule
"the API is the source of truth" literally true and keeps the edge function at
sub-millisecond cost.

**Presence is split from authority — the cookie inventory.** The naive version of this
design gives `sl_access` / `sl_refresh` `Domain=.schemaloom.dev` so that
`app.schemaloom.dev` can read them server-side in middleware. That silently hands a
**refresh token to every subdomain of `schemaloom.dev`** — the web app, a future
marketing/status/docs host, and anything a third party is ever allowed to run there.
One XSS on any of them, or one over-eager request logger in `apps/web`, is a full
account takeover. Middleware only needs to know *whether* someone is signed in, so it
gets a cookie that says only that:

| Cookie | Set by | Domain | httpOnly | Lifetime | Read by |
|---|---|---|---|---|---|
| `sl_access` | API | **host-only** (`api.schemaloom.dev`) | yes | `ACCESS_TOKEN_TTL` | API only |
| `sl_refresh` | API | **host-only**, `Path=/auth` | yes | `REFRESH_TOKEN_TTL` | API only |
| `sl_presence` | API | `${COOKIE_DOMAIN}` | yes | = `sl_refresh` | `apps/web` middleware |
| `sl_csrf` | API | `${COOKIE_DOMAIN}` | **no** (SPA must read it) | = `sl_refresh` | `api-client.ts` → `X-CSRF-Token` |
| `sl_session` *(Phase 3)* | API | **host-only**, `Path=/` | yes | `min(link.expiresAt, 12h)` | API only — the share-link subject |

`sl_presence` has **no value of consequence** — it is `1`. It is not a token, it grants
nothing, and forging it gets you the app shell and an immediate 401, exactly as before.
All are `SameSite=Lax`, `Secure` when `COOKIE_SECURE`. `COOKIE_DOMAIN` exists
*only* for the two non-authoritative cookies; it is never applied to `sl_access`,
`sl_refresh` or `sl_session`.

**`sl_session` is `Path=/`, not `Path=/s`** (doc 05 §7.12). Everything a share-link visitor
does after unlocking goes to `/api/projects/:id/ir`, `/api/projects/:id/search` and the
Socket.IO upgrade; a `/s`-scoped cookie is never sent to `/api/**`, so the guard would find
no subject and the whole flow would 401. The scoping that matters is not the path: it is the
`pid` claim inside the cookie, checked against the requested project on every request, plus
the `SHARE_LINK_ROUTES` allow-list. It is signed and **stateless** — there is no `sessions`
row behind it (doc 02 Key decision 9 deleted `sessions.share_link_id` because
`sessions.user_id` is NOT NULL). It is host-only on the API origin for the same reason
`sl_access` is.

**The middleware matcher must exclude `/s`** when share links land in Phase 3, or a visitor
with no `sl_presence` cookie is bounced to `/login` before the unlock page renders. That is
one more negative lookahead in the matcher below, listed here so it is not discovered by the
first person to click a share link.

Known dev-environment limit, stated rather than discovered later: cookies ignore ports,
so on `localhost` the host-only session cookies are visible to every dev server the
developer runs on localhost. That is unavoidable with host-only cookies on a shared
hostname and is acceptable for dev secrets; it does not apply in any deployed
environment. Use `127.0.0.1` for the api and `localhost` for the web app if you want
them separated locally too.

**CORS decision that makes this work:** web and api are same-*site* in both
environments — `localhost:3000` / `localhost:3001` in dev, and `app.schemaloom.dev` /
`api.schemaloom.dev` in production — so `SameSite=Lax` cookies flow on XHR. The browser
talks to the API **directly** with `credentials: 'include'` plus a CORS allow-list.
No Next rewrite proxy and no Next route handlers: a proxy would add a hop, break the
Socket.IO upgrade in Phase 4, and put a second server in the SSE path.
Consequence: `apps/web` has **no `src/app/api/` directory at all.**

---

## 6. `packages/*` — directory trees

```
packages/schema-model/src/        ← doc 04 §0.1 owns this list
├─ ids.ts                 `Id` — exactly one id type, a cuid string identical to the DB row id (C1)
├─ model.ts               IrObjectMap, IrObjectType, IR_OBJECT_TYPES, IrCollections, SchemaModel
├─ schemas.ts             every zod schema — the only place an IR type is DEFINED
├─ types.ts               the z.infer re-exports (Entity, Field, Link, …)
├─ rows.ts assemble.ts    the *Row structural types + assembleModel (the C3 read path)
├─ ops.ts                 SchemaOperation, batch, result, requirementsOf, applyOps, mergeResult
├─ index.ts               ModelIndex, createIndex, ~20 traversal helpers
├─ logical-key.ts diff.ts validate.ts upgrade.ts
└─ redact.ts              RedactedModel, RawSchemaModel, VisibilityContext, redact, redactPatch
                          — doc 05 §8.6 requires the brand, the private payload and the only
                            unwrap to share ONE module, and C10 puts that module here

packages/engine-sdk/src/          ← doc 03 §1 owns this list
├─ ir.ts                  the ONLY file that names a schema-model export
├─ diagnostics.ts         Diagnostic, SourceRange, QuickFix, renderDiagnostic
├─ errors.ts              EngineError + the four subclasses the registry and gates throw
├─ capabilities.ts        ENGINE_FEATURES, EngineCapabilities, defineCapabilities, the helpers
├─ type-catalog.ts        TypeDescriptor, ResolvedType, createTypeCatalog
├─ props.ts               EnginePropsSchemas, parseEngineProps
├─ links.ts               checkLink — the declarative link-rule evaluator
├─ terminology.ts         Term, TerminologyBundle, formatMessage, normalizerFor (strings, no React)
├─ versioning.ts          compareEngineVersion + the read-only verdicts
├─ validator.ts importer.ts exporter.ts migration.ts query.ts ai.ts
├─ definition.ts          EngineStaticFacet, EngineDefinition
├─ registry.ts            createEngineRegistry(announced) — framework-free; Nest wraps it once (§4.2)
├─ index.ts               ← "." export. MUST NOT import react.
├─ ui/
│  ├─ plugin.ts           EngineUiPlugin: node renderers, panel sections, type picker
│  ├─ registry.ts         createEngineUiRegistry() + createEngineFacetRegistry()
│  └─ index.ts            ← "./ui" export. React types only, no runtime React import.
│                            ALSO re-exports the isomorphic surface browser code needs (§6.1).
└─ conformance/
   ├─ suite.ts            runEngineConformance(engine, fixtures) — doc 03 §17
   ├─ fixtures/           IR JSON fixtures ONLY — format-agnostic, no .sql
   └─ index.ts            ← "./conformance" export. vitest is a plain devDependency.

packages/contracts/src/
├─ permissions.ts         the C5 atom union, built-in role → atom map, org-role union
├─ errors.ts pagination.ts
├─ auth/ users/ orgs/ access/ workspaces/ projects/ engines/ schema/ docs/ transfer/
│                         request + response zod schemas (one folder per api module that has routes)
├─ fixtures.ts            seed-payload shapes shared with the e2e package (§12)
└─ index.ts

packages/engines/postgresql/src/
├─ static/                descriptor, capabilities, typeCatalog, propsSchemas, terminology, linkRules
│  └─ index.ts            ← "./static" export. zod only. NO libpg-query.
├─ importer/              DDL → IR (libpg-query, lazily imported)
├─ exporter/              IR → ordered DDL incl. COMMENT ON
├─ migration/             AnnotatedDiff → ALTER script, destructive / lossy / rewrite flags
├─ query-validator/       parse AI SQL, resolve identifiers against the redacted IR
├─ ai-profile/            system prompt + SCS serialiser
├─ kinds.ts               PG_ENTITY_KINDS + the `isPgEntity` guard (doc 04 §3)
├─ references.ts          extractReferences over CHECK bodies, defaults, index expressions
├─ __fixtures__/          native DDL the conformance suite consumes (doc 01 §6.2)
├─ conformance.spec.ts    runEngineConformance(postgresEngine, fixtures)
└─ index.ts               ← "." export: the assembled EngineDefinition (server only)

packages/engines/postgresql-ui/src/
├─ nodes/                 TableNode, ViewNode, MatViewNode (React Flow node types)
├─ panels/                entity / field / link / index property sections
├─ type-picker/           PostgresTypePicker + TypeBadge
├─ link-rules.ts terminology.ts
└─ index.ts               postgresEngineUi: EngineUiPlugin

packages/ui/src/
├─ primitives/            button, dialog, dropdown-menu, popover, tooltip, tabs, context-menu,
│                         select, toast, scroll-area, toggle, input, checkbox, skeleton …
├─ cn.ts                  clsx + tailwind-merge
└─ index.ts

packages/config/
├─ tsconfig/{base,library,nest,next}.json
├─ eslint/{base,node,react}.js
├─ tailwind/theme.css     @theme tokens + Radix Colors scales + light/dark
├─ tsup.base.mjs          plain JS, JSDoc-typed — see below
├─ vitest.base.mjs        plain JS
└─ package.json           no build; "exports" maps each file path verbatim
```

**`packages/config` is JavaScript and JSON only — never TypeScript.** This is the one
package exempt from §9.1's "consumers import built output" rule, and the exemption only
works if there is nothing to build. A `tsup.base.ts` would be unloadable: tsup's config
loader (`bundle-require`) treats a bare specifier that resolves into `node_modules` as
external, so Node receives a `.ts` file and throws `ERR_UNKNOWN_FILE_EXTENSION` — and
it would do so in the package every other package's build depends on. So the two shared
presets ship as `.mjs` with JSDoc types for editor support:

```js
// packages/config/tsup.base.mjs
/** @type {import('tsup').Options} */
export const base = Object.freeze({
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  outDir: 'dist',
  splitting: true,
});
```

### 6.1 `/ui` re-exports the type surface browser code needs

The ESLint rule in §7.1 forbids browser code from importing the bare
`@schemaloom/engine-sdk` specifier. But spec §3.3 requires *"features not supported by
an engine's capabilities are hidden automatically"*, and `use-engine-ui.ts` (§5) has to
provide capability-gating helpers — so the browser genuinely needs `EngineCapabilities`.
Without the following rule, the feature-gating the spec mandates is unimplementable
without violating our own lint rule.

**Rule: `engine-sdk/src/ui/index.ts` re-exports the whole *isomorphic* surface — every type
and every pure function from the `.` modules that browser code legitimately needs.** `/ui` is
a strict superset of the browser's surface; there is never a reason for browser code to
reach the `.` entry. Doc 03 owns where these are declared and their exact shapes; this is the
re-export list.

```ts
// packages/engine-sdk/src/ui/index.ts
// --- type-only ------------------------------------------------------------------
export type {
  EngineCapabilities, EngineFeature, NamespaceSupport,
  EntityKindDescriptor, LinkKindDescriptor, IndexTypeDescriptor,
  ConstraintKindDescriptor, CustomTypeKindDescriptor,
  QueryLanguageDescriptor, IdentifierRules,
  ImportFormatDescriptor, ExportFormatDescriptor,
} from '../capabilities';
export type {
  TypeCatalog, TypeDescriptor, TypeParameterDescriptor,
  ResolvedType, TypeResolutionContext, TypePickerOption,
} from '../type-catalog';
export type { EngineProps, EnginePropsSchemas, EnginePropsResolver } from '../props';
export type { EngineStaticFacet, EngineParadigm } from '../definition';
export type { EngineId, EnginePropsKind, Diagnostic, DiagnosticSeverity,
              DiagnosticTarget, DiagnosticParam, DiagnosticMessages,
              QuickFix, QuickFixEdit, SourceRange } from '../diagnostics';
export type { Term, TerminologyBundle, CoreTermKey, TermSubject,
              CoreMessageId } from '../terminology';
export type { LinkCheck, LinkCheckInput, LinkCheckReason } from '../links';
export type { AnnouncedEngine, EngineDescriptor, EngineCatalog } from '../registry';
export type { EngineVersionVerdict } from '../versioning';

// --- values: pure, isomorphic, no React, no parser, no Node built-in --------------
export {
  supportsNamespaces, anyLinkKindEnforced, anyCompositeEndpoint, anyLinkKindHasFields,
  anyIndexTypeUnique, anyTypeSupportsArray, hasEntityKind, hasConstraintKind,
  hasCustomTypeKind, anySchemalessEntity, canImport, canExport,
  engineCapabilitiesSchema,
} from '../capabilities';
export { parseEngineProps } from '../props';
export { checkLink } from '../links';
export { renderDiagnostic, sortDiagnostics, PROPERTY_SEVERITY_RANK } from '../diagnostics';
export { formatMessage, resolveTerm, normalizerFor,
         CORE_MESSAGE_TEMPLATES, FALLBACK_TERMINOLOGY } from '../terminology';
export { compareEngineVersion } from '../versioning';
export { EngineError, UnknownEngineError, EngineFeatureUnsupportedError } from '../errors';

// --- ./ui's own modules ----------------------------------------------------------
export * from './plugin';
export * from './registry';   // createEngineUiRegistry, createEngineFacetRegistry
```

Three consequences worth stating, because the first draft of this section got them wrong:

- **Value re-exports are deliberate, not an oversight.** `checkLink` runs on every canvas drag
  frame and again on the server write path — one implementation or they drift (doc 03 §7).
  `parseEngineProps` is what makes a property panel validate locally instead of round-tripping
  every keystroke. `formatMessage` is how core renders a noun without hard-coding "table".
  Keeping these server-side would make the features they serve unimplementable.
- **They do not weaken the React boundary.** `dist/ui.js` importing a shared chunk is fine;
  what matters is the two mechanisms in §7.1 — `apps/api` only ever resolves the `.` entry, and
  `react` is not in the api's dependency tree at all, so an `import 'react'` there is an
  unresolvable module. `splitting: true` (§6) emits the shared code once rather than duplicating
  it across entries.
- **Still not re-exported:** `importer.ts`, `exporter.ts`, `migration.ts`, `query.ts`, `ai.ts`,
  `validator.ts` and `EngineDefinition` itself. Those are server surfaces. Note that
  `propsSchemas` *is* on `EngineStaticFacet` (doc 03 §6), so the browser gets the schemas from
  the engine's `/static` entry — but the **types** describing them have to come from here or
  the browser cannot name what it is holding.

### 6.2 The conformance suite asserts invariants; the *engine* owns its fixtures

The suite previously promised "shared `.sql` / `.json` fixtures every engine must
handle" inside the engine-*neutral* SDK. A `.sql` fixture is not engine-neutral: MySQL
chokes on Postgres DDL, and MongoDB, Redis, Neo4j and DynamoDB cannot parse SQL at all.
The single most load-bearing promise of the plugin architecture — "a new engine's whole
test obligation is one line" — would break at the first test of it. Ownership is
therefore inverted:

```ts
// packages/engines/<x>/src/conformance.spec.ts — the entire file
import { runEngineConformance } from '@schemaloom/engine-sdk/conformance';
import { xEngine } from './index';
import { fixtures } from './__fixtures__';   // native DDL/JSON the engine supplies

runEngineConformance(xEngine, fixtures);
```

The SDK holds only **format-agnostic IR JSON fixtures** (a small, engine-neutral model
used for the IR-side assertions). The **native** fixtures come from the engine.

**Doc 03 §17 owns the check list** — `ConformanceCheckId` is an exhaustive union of named
checks, and `runEngineConformance` registers one vitest `it` per check, so a skip needs
a written reason that the run summary prints. This section owns only the *ownership* rule
above and the five properties the repo layout depends on:

1. **Round-trip** (`roundtrip/ddl-ir-ddl`, `roundtrip/idempotent`) — the reason engine
   fixtures are native and live in the engine package.
2. **Props-schema coverage and strictness** (`props/schemas-are-strict`,
   `props/accept-importer-output`) — the reason `propsSchemas` is on the static facet.
3. **Capability/service agreement** (`capabilities/services-match-features`):
   `features.migrations === (engine.migrationGenerator !== undefined)` and
   `features.queryValidation === (engine.queryValidator !== undefined)`. This is what stops
   an engine advertising a feature it has not implemented, and it is what lets §13 ship the
   Phase 1 PostgreSQL engine with no `migration/` or `query-validator/` directory.
   (`aiProfile` has no feature atom — nothing in core branches on AI beyond hiding the panel —
   and there is no `introspector` at all; doc 03 cut it.)
4. **Unsupported-statement reporting** (`import/accounts-for-every-statement`,
   `import/reasons-present`) — spec §3.4's "report unsupported statements instead of failing
   silently", as a test.
5. **Client-bundle budget** (`static/bundle-size`) — bundles the package's `/static` entry
   with esbuild and asserts it is under 50 KB min+gzip. This is the check that keeps
   `libpg-query` from creeping into the browser, which is the whole point of §7.1's two-entry
   split.

Most checks need no fixtures at all, so an engine that supplies none still gets a meaningful
suite.

---

## 7. Workspace dependency graph (proof of C10)

```mermaid
graph TD
  zod["zod (external)"]
  react["react (external)"]
  pg["libpg-query (external)"]

  SM["@schemaloom/schema-model"]
  SDK["@schemaloom/engine-sdk (.)"]
  SDKUI["@schemaloom/engine-sdk/ui"]
  SDKCF["@schemaloom/engine-sdk/conformance"]
  CT["@schemaloom/contracts"]
  PG["@schemaloom/engine-postgresql (.)"]
  PGS["@schemaloom/engine-postgresql/static"]
  UI["@schemaloom/ui"]
  PGUI["@schemaloom/engine-postgresql-ui"]
  API["apps/api"]
  WEB["apps/web"]
  E2E["e2e"]

  SM --> zod
  SDK --> SM
  SDK --> zod
  SDKUI --> SDK
  SDKUI -.->|"type-only"| react
  SDKCF --> SDK
  CT --> SM
  CT --> zod
  PGS --> SDK
  PGS --> zod
  PG --> PGS
  PG --> pg
  UI --> react
  PGUI --> SDKUI
  PGUI --> PGS
  PGUI --> UI
  PGUI --> react
  API --> SM
  API --> CT
  API --> SDK
  API --> PG
  WEB --> SM
  WEB --> CT
  WEB --> SDKUI
  WEB --> PGS
  WEB --> PGUI
  WEB --> UI
  E2E --> CT
```

`API --> SM` and `WEB --> SM` are **not** decoration. `SchemaModule` assembles the IR
from relational rows and the canvas renders IR objects, so both apps import
`@schemaloom/schema-model` types directly. Under `node-linker=isolated` an undeclared
import is a hard resolution failure, not a lucky hoist — the same property §7.1(b)
relies on to keep React out of the api cuts both ways. Same reason `API --> SDK`
exists explicitly rather than arriving via `engine-postgresql`, and `WEB --> PGS`
rather than via `engine-postgresql-ui`.

**Topological levels** — an edge only ever points to a lower level, which is the cycle
proof (a cycle requires an edge back up):

| Level | Packages |
|---|---|
| 0 | `zod`, `react`, `libpg-query` (externals) |
| 1 | `schema-model`, `ui` |
| 2 | `engine-sdk` (`.`), `contracts` |
| 3 | `engine-sdk/ui`, `engine-sdk/conformance`, `engine-postgresql/static` |
| 4 | `engine-postgresql` (`.`), `engine-postgresql-ui` |
| 5 | `apps/api`, `apps/web` |
| 6 | `e2e` (depends on `contracts` for payload types; drives both apps over **HTTP**, never by importing them — see §8.2 for how the task graph orders it after both app builds) |

**C10 checks:**

1. *`schema-model` depends only on zod* — enforced by its `package.json`
   `dependencies: { "zod": "catalog:" }` and nothing else. Any accidental import of a
   workspace package fails at `pnpm build` because pnpm's isolated `node_modules`
   does not contain it.
2. *No cycles* — Turborepo builds the `^build` graph from `package.json` dependencies
   and **fails the run** on a cycle. This is the enforcement; no extra lint plugin.
3. *`engine-sdk` must not import React* — §7.1.
4. *Nothing depends on the apps* — the apps are `"private": true` with no `exports`
   field, so they are not importable even by accident.

### 7.1 How the subpath exports keep React out of the backend bundle

Two mechanisms, both structural rather than conventional:

**(a) Separate entry points.** A bundler/`tsc` resolves a package **per entry point**.
`apps/api` only ever imports `@schemaloom/engine-sdk` (the `.` entry). `dist/index.js`
never imports `./ui.js`, so the React-typed module is never in api's module graph.

**(b) React is not installed in the api's dependency tree.** The mechanism is
`node-linker=isolated` plus `apps/api` not declaring `react` — nothing else.
`apps/api/node_modules` contains only its declared dependencies and their symlinks, so
`react` is not resolvable from anywhere in the api's module graph and an
`import 'react'` inside a non-`/ui` file is a hard `tsc` error in `typecheck`.

Being precise about this because the earlier draft was wrong: `strict-peer-dependencies`
does **not** enforce it. That flag ignores unmet peers marked `optional`, which is
exactly how `react` is declared. The isolated layout is doing all the work, and it does
it whether or not the flag is set. The flag has been dropped (§8.1).

The exact `packages/engine-sdk/package.json` (the load-bearing parts):

```jsonc
{
  "name": "@schemaloom/engine-sdk",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./ui": {
      "types": "./dist/ui.d.ts",
      "import": "./dist/ui.js",
      "require": "./dist/ui.cjs"
    },
    "./conformance": {
      "types": "./dist/conformance.d.ts",
      "import": "./dist/conformance.js",
      "require": "./dist/conformance.cjs"
    },
    "./package.json": "./package.json"
  },
  "files": ["dist"],
  "dependencies": {
    "@schemaloom/schema-model": "workspace:*",
    "zod": "catalog:"
  },
  "peerDependencies": {
    "react": "catalog:"
  },
  "peerDependenciesMeta": {
    "react": { "optional": true }
  },
  "devDependencies": {
    "@schemaloom/config": "workspace:*",
    "react": "catalog:",
    "tsup": "catalog:",
    "typescript": "catalog:",
    "vitest": "catalog:"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "test": "vitest run"
  }
}
```

`tsup.config.ts` for it:

```ts
import { defineConfig } from 'tsup';
import { base } from '@schemaloom/config/tsup.base.mjs';

export default defineConfig({
  ...base,
  entry: {
    index: 'src/index.ts',
    ui: 'src/ui/index.ts',
    conformance: 'src/conformance/index.ts',
  },
  external: ['react', 'vitest'],
});
```

(`.mjs`, not `.ts` — see §6: tsup's own config loader cannot load a TypeScript preset
out of `node_modules`.)

And the same trick one level down, on the engine:

```jsonc
// packages/engines/postgresql/package.json
{
  "name": "@schemaloom/engine-postgresql",
  "exports": {
    ".":        { "types": "./dist/index.d.ts",  "import": "./dist/index.js",  "require": "./dist/index.cjs" },
    "./static": { "types": "./dist/static.d.ts", "import": "./dist/static.js", "require": "./dist/static.cjs" }
  },
  "dependencies": {
    "@schemaloom/engine-sdk": "workspace:*",
    "@schemaloom/schema-model": "workspace:*",
    "libpg-query": "catalog:",
    "zod": "catalog:"
  }
}
```

Why `./static` exists: the **frontend genuinely needs** the type catalog, capabilities,
terminology and `propsSchemas` (the type picker and the property-panel forms are built
from them), but must not pull `libpg-query` (a WASM build of the real Postgres parser)
into the browser bundle. `./static` is pure TS + zod; `.` imports `./static` and adds
the parser-backed pieces. One extra entry point replaces "ship the catalog over HTTP
and lose zod validation on the client".

Two build-config consequences of that shape, both load-bearing enough to fix here:

**(1) `splitting: true`, not `false`.** The `.` entry imports `./static`. With splitting
off, every entry inlines its imports, so the props zod schemas, capabilities and type
catalog exist as *two separate object identities* — one in `dist/index.js`, one in
`dist/static.js`. Anything that compares schema or descriptor instances by reference
(and the UI's "is this the same type descriptor" checks will) silently breaks. `base` in
§6 therefore sets `splitting: true`; the shared chunk is emitted once and both entries
import it.

**(2) The `libpg-query` dynamic import must survive into the CJS output.**
`libpg-query` v17 is ESM + WASM with top-level `await`. esbuild's default CJS transform
rewrites `await import('libpg-query')` into `require()`, which throws
`ERR_REQUIRE_ASYNC_MODULE` on Node 22 — undoing exactly the laziness the design depends
on. `packages/engines/postgresql/tsup.config.ts` therefore pins the feature:

```ts
export default defineConfig({
  ...base,
  entry: { index: 'src/index.ts', static: 'src/static/index.ts' },
  external: ['libpg-query'],
  esbuildOptions(options) {
    options.supported = { ...options.supported, 'dynamic-import': true };
  },
});
```

Node's CJS loader supports `import()` of an ESM module, so the CommonJS `apps/api`
loads the parser fine — it just must not be *rewritten* on the way there.

Guard against accidentally importing the wrong entry, in `packages/config/eslint/react.js`:

```js
'no-restricted-imports': ['error', { paths: [
  { name: '@schemaloom/engine-postgresql',
    message: 'Browser code must import @schemaloom/engine-postgresql/static.' },
  { name: '@schemaloom/engine-sdk',
    message: 'Browser code must import @schemaloom/engine-sdk/ui.' },
]}]
```

> **Resolution requirement:** subpath `exports` are *ignored* by TypeScript's legacy
> `"moduleResolution": "node"`. Every tsconfig preset in §9 therefore uses `node16`
> or `bundler`. Using `node`/`node10` anywhere silently breaks the whole scheme.

---

## 8. pnpm workspace + Turborepo

### 8.1 `pnpm-workspace.yaml`

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'packages/engines/*'
  - 'e2e'

# Single source of truth for versions shared across packages.
catalog:
  typescript: ^5.9.0
  zod: ^4.0.0
  react: ^19.1.0
  react-dom: ^19.1.0
  '@types/react': ^19.1.0
  tsup: ^8.5.0
  vitest: ^3.2.0
  eslint: ^9.35.0
  prettier: ^3.6.0
  libpg-query: ^17.0.0

# pnpm 10 blocks lifecycle scripts unless listed.
onlyBuiltDependencies:
  - '@prisma/client'
  - prisma
  - argon2
  - esbuild
  - '@swc/core'
  - sharp
  - libpg-query
```

`.npmrc`:

```ini
# The whole file. This one line is what makes "apps/api has no react" a fact
# rather than a rule: each package's node_modules contains only its own declared
# dependencies, so an undeclared import is an unresolvable module, not a lucky hoist.
node-linker=isolated
```

Three lines an earlier draft had here are **deliberately absent**:

- `strict-peer-dependencies=true` — it does **not** enforce the React boundary (§7.1:
  the flag ignores unmet peers marked `optional`, which is exactly how `react` is
  declared, so it buys nothing), and across React 19 + `@xyflow/react` + TipTap + ~15
  Radix packages + CodeMirror it will hard-fail the very first `pnpm install` on some
  unrelated package's lagging peer range. The predictable result is someone switching it
  off at 9am on day one and the doc's stated boundary rationale evaporating with it.
  `node-linker=isolated` does the real work and does it unconditionally.
- `prefer-workspace-packages=true` / `link-workspace-packages=true` — redundant. Every
  internal dependency is declared with the `workspace:*` protocol, which pnpm resolves
  from the workspace unconditionally and fails on if no local package matches.

Root `package.json` scripts are thin wrappers, nothing clever:

```jsonc
{
  "name": "schemaloom",
  "private": true,
  "packageManager": "pnpm@10.15.0",
  "engines": { "node": ">=22.12.0", "pnpm": ">=10" },
  "scripts": {
    "dev": "turbo dev",
    "build": "turbo build",
    "lint": "turbo lint",
    "typecheck": "turbo typecheck",
    "test": "turbo test",
    "test:int": "turbo test:int",
    "test:e2e": "turbo test:e2e",
    "db:migrate": "turbo db:migrate",
    "db:seed": "turbo db:seed",
    "infra:up": "docker compose up -d",
    "infra:down": "docker compose down",
    "format": "prettier --write ."
  }
}
```

### 8.2 `turbo.json`

```jsonc
{
  "$schema": "https://turborepo.com/schema.json",
  "ui": "tui",
  "globalDependencies": ["pnpm-lock.yaml", "packages/config/**", ".nvmrc"],
  "globalEnv": ["NODE_ENV"],
  "globalPassThroughEnv": ["CI", "TURBO_*"],
  "tasks": {
    "db:generate": {
      "inputs": ["prisma/schema.prisma", "prisma/migrations/**", "package.json"],
      "outputs": ["src/generated/prisma/**"]
    },
    "build": {
      "dependsOn": ["^build", "db:generate"],
      "inputs": ["$TURBO_DEFAULT$", "!**/*.spec.ts", "!**/*.spec.tsx", "!**/*.int.spec.ts"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"],
      "env": ["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_APP_URL"]
    },
    "dev": {
      "dependsOn": ["^build"],
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^build", "db:generate"],
      "outputs": []
    },
    "typecheck": {
      "dependsOn": ["^build", "db:generate"],
      "outputs": []
    },
    "test": {
      "dependsOn": ["^build", "db:generate"],
      "outputs": ["coverage/**"]
    },
    "test:int": {
      "dependsOn": ["^build", "db:generate"],
      "cache": false,
      "env": ["DATABASE_URL_TEST", "REDIS_URL_TEST", "REDIS_KEY_PREFIX"]
    },
    "test:e2e": {
      "dependsOn": ["@schemaloom/api#build", "@schemaloom/web#build"],
      "cache": false,
      "outputs": ["playwright-report/**", "test-results/**"],
      "env": ["E2E_BASE_URL", "E2E_API_URL", "DATABASE_URL_E2E", "REDIS_KEY_PREFIX"]
    },
    "db:migrate": {
      "cache": false,
      "interactive": true
    },
    "db:seed": {
      "dependsOn": ["db:migrate"],
      "cache": false
    }
  }
}
```

**Task-by-task rationale**

| Task | Where it runs | dependsOn | Cached | Outputs |
|---|---|---|---|---|
| `db:generate` | `apps/api` only | — | yes | `src/generated/prisma/**` |
| `build` | every package + both apps | `^build`, `db:generate` | yes | `dist/**`, `.next/**` (minus `.next/cache`) |
| `dev` | every package (`tsup --watch`) + both apps | `^build` (one cold build so `dist/*.d.ts` exists before `next dev`/`nest start` attach) | no | — |
| `lint` | everywhere | `^build`, `db:generate` (type-aware rules need dependency `.d.ts` and the Prisma client) | yes | none |
| `typecheck` | everywhere (`tsc --noEmit`) | same | yes | none |
| `test` | everywhere — **unit only**, no external services, so it stays cacheable and runs on a clean machine | `^build`, `db:generate` | yes | `coverage/**` |
| `test:int` | `apps/api` only — real Postgres + Redis | `^build`, `db:generate` | **no** (depends on DB state) | — |
| `test:e2e` | `e2e` package | `@schemaloom/api#build`, `@schemaloom/web#build` | **no** | `playwright-report/**` |
| `db:migrate` | `apps/api` | — | no, `interactive` (prisma prompts for the migration name) | — |
| `db:seed` | `apps/api` | `db:migrate` | no | — |

Two tasks are **added** to the list the brief named, both because Phase 1 cannot work
without them (Key decision 22):

- `db:generate` — `tsc` cannot typecheck `apps/api` until the Prisma client exists.
  Folding it into `build` would re-run it for `lint` and `typecheck` too and would not
  be independently cacheable.
- `test:int` — keeping integration tests inside `test` would make `turbo test` require
  Docker on every machine and would make the whole `test` task uncacheable.

**Why `test:e2e` names the two apps explicitly.** `e2e` has no workspace dependency on
either app (it drives them over HTTP — §7's level table), so `^build` resolves to the
empty set and `build` does not exist in that package: `dependsOn: ["^build", "build"]`
would order *nothing*, and `pnpm test:e2e` on a clean checkout would run Playwright
against unbuilt apps. Turborepo expresses a cross-package task dependency directly with
`<package>#<task>`, so the graph is written out rather than hoped for. The alternative —
adding both apps as devDependencies of `e2e` — would make `e2e` importable-from and
reintroduce the coupling §7's C10 check 4 exists to prevent.

**Environment isolation, written into the task graph rather than left to discipline.**
Two deliberate substitutions in the `env` arrays above, both of which prevent a
data-loss class of bug:

- `test:e2e` reads `DATABASE_URL_E2E`, **never** `DATABASE_URL`. The e2e global setup
  creates, migrates, seeds and truncates its database; pointing that at the developer's
  dev database costs an afternoon of demo data. §12 adds the belt to this braces: the
  setup **refuses to run** unless the database name in the URL ends in `_e2e`.
- `test:int` reads `REDIS_URL_TEST`, **never** `REDIS_URL`. A test that enqueues an
  export or email job on the developer's dev Redis is picked up and executed by their
  running `pnpm dev` api; a test that clears a permission-cache prefix invalidates their
  session; a flush nukes the dev queue. All three present as "flaky tests" for about two
  weeks. `REDIS_URL_TEST` points at a different logical DB (`redis://localhost:6379/1`)
  and `REDIS_KEY_PREFIX` (§4.4) keeps the isolation even if someone points both at DB 0.

**Prisma client output and generator options.** The generator writes into the repo tree,
not `node_modules`, so Turborepo can declare it as a cacheable output. The full block —
spelled out because `prisma-client` (the ESM-first generator, not `prisma-client-js`) has
options that are required in practice here, and two implementers guessing differently
both believe they followed the document:

```prisma
generator client {
  provider            = "prisma-client"
  output              = "../src/generated/prisma"
  runtime             = "nodejs"
  moduleFormat        = "cjs"
  importFileExtension = ""
}
```

`moduleFormat = "cjs"` because `apps/api` has no `"type"` field and compiles with
`module: Node16` (§9.3) — the ESM default would produce `ERR_REQUIRE_ESM` at boot.
`importFileExtension = ""` because a `tsc`-compiled CJS output must not carry explicit
`.js` specifiers. Getting either wrong fails at boot or at typecheck, not in review.

Generated code is excluded from the things it cannot satisfy:

- `apps/api/src/generated/**` is in `.gitignore`.
- It is in `eslint.config.js`'s global `ignores` (flat config has no `.eslintignore`).
- It is in the `exclude` of the tsconfig used for type-aware lint, so `noUnusedLocals`
  and friends are not asserted against generated declarations. It stays *inside* the
  `nest build` `rootDir`, which is the point — the client is compiled and shipped with
  the app.

### 8.3 `.github/workflows/ci.yml`

The turbo graph is half the pipeline; the other half is where Postgres and Redis come
from, because §10's compose file is explicitly dev-only and the apps run on the host.
Without this section `test:int` cannot run in CI at all.

**Three jobs, run in parallel after a shared setup, all on `ubuntu-latest`.**

```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  TURBO_TELEMETRY_DISABLED: 1

jobs:
  static:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4          # version comes from packageManager
      - uses: actions/setup-node@v4
        with: { node-version-file: '.nvmrc', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm turbo lint typecheck test build
        env:
          NEXT_PUBLIC_API_URL: http://localhost:3001
          NEXT_PUBLIC_APP_URL: http://localhost:3000

  integration:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine          # same images and healthchecks as §10
        env:
          POSTGRES_USER: schemaloom
          POSTGRES_PASSWORD: schemaloom
          POSTGRES_DB: schemaloom_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U schemaloom -d schemaloom_test"
          --health-interval 5s --health-timeout 3s --health-retries 20
      redis:
        image: redis:7-alpine
        ports: ['6379:6379']
        options: >-
          --health-cmd "redis-cli ping"
          --health-interval 5s --health-timeout 3s --health-retries 20
    env:
      DATABASE_URL: postgresql://schemaloom:schemaloom@localhost:5432/schemaloom_test
      DATABASE_URL_TEST: postgresql://schemaloom:schemaloom@localhost:5432/schemaloom_test
      REDIS_URL_TEST: redis://localhost:6379/1
      REDIS_KEY_PREFIX: 'sl-test:'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: '.nvmrc', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @schemaloom/api db:deploy   # migrate deploy, not migrate dev
      - run: pnpm turbo test:int

  e2e:
    runs-on: ubuntu-latest
    services: { postgres: …same…, redis: …same…, minio: …, mailpit: … }
    env:
      DATABASE_URL_E2E: postgresql://schemaloom:schemaloom@localhost:5432/schemaloom_e2e
      E2E_BASE_URL: http://localhost:3000
      E2E_API_URL: http://localhost:3001
      REDIS_KEY_PREFIX: 'sl-e2e:'
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: '.nvmrc', cache: 'pnpm' }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm turbo test:e2e            # builds both apps, then Playwright
        # Playwright's own `webServer` (§12) starts and waits for api + web.
      - uses: actions/upload-artifact@v4
        if: failure()
        with: { name: playwright-report, path: e2e/playwright-report }
```

Decisions this pins down, each previously unanswered:

| Question | Answer |
|---|---|
| Where does `test:int` get Postgres/Redis? | GitHub **service containers**, same images and healthchecks as §10's compose so a failure reproduces locally. Compose is never used in CI. |
| How do migrations run? | `prisma migrate deploy` (not `migrate dev` — non-interactive, no drift prompts, no shadow database) as a step before `test:int`. |
| Does `DATABASE_URL_TEST` point at a service container? | Yes; `DATABASE_URL` is set to the *same* value in the integration job only, because the Prisma CLI reads `DATABASE_URL`. There is no dev database in CI to damage. |
| pnpm / Node install and cache | `pnpm/action-setup` (version from root `packageManager`) + `actions/setup-node` with `node-version-file: .nvmrc` and `cache: pnpm`. |
| Browsers | `playwright install --with-deps chromium` in the e2e job only. Phase 1 runs Chromium only; add Firefox/WebKit when a bug justifies the ~4× wall clock. |
| Starting the servers for e2e | Playwright `webServer` (§12), not a CI step — so `pnpm test:e2e` behaves identically on a laptop. |
| Turborepo remote caching | **None in Phase 1.** Local `.turbo` plus `actions/setup-node`'s pnpm-store cache is enough at this repo size; remote caching adds a token, a vendor and a cache-poisoning surface for a build measured in a couple of minutes. Revisit when CI exceeds ~10 minutes. |

Each job re-installs rather than sharing an artifact: `pnpm install --frozen-lockfile`
off a warm store is faster than uploading and downloading a `node_modules` tarball, and
it keeps the jobs independently re-runnable.

---

## 9. TypeScript setup

### 9.1 Packages are **compiled with tsup**, not consumed as source

**Decision: build each library package to `dist/` (ESM + CJS + `.d.ts`) with tsup;
consumers import the built output.** Not source-first / "just-in-time" packages.

Rationale, in order of weight:

1. **NestJS.** `nest build` (tsc or SWC) compiles `apps/api/src` with a `rootDir`.
   Pulling raw `.ts` out of `node_modules` means either abandoning `rootDir`, or
   switching to the webpack builder, or SWC with hand-written path maps — three
   different escape hatches, all of which break `nest start --watch` in some mode.
   A compiled dependency needs none of them.
2. **Uniformity.** `next build`, `nest build`, `vitest`, `tsc --noEmit`, `eslint`
   (type-aware) and Playwright all resolve `@schemaloom/*` identically. Source-first
   requires per-tool configuration (`transpilePackages`, vitest `alias`, eslint
   `project`), i.e. four places to get wrong.
3. **The cost is already paid.** Turborepo caches `dist/**`; a package that did not
   change is a cache hit, so the "extra build step" is measured in milliseconds after
   the first run. In dev, `tsup --watch` is the package's `dev` task and rebuilds in
   ~50 ms.

Dual format (`esm` + `cjs`) because `apps/api` is CommonJS (decorators +
`emitDecoratorMetadata`) and `apps/web` bundles ESM. That is one line of tsup config,
and dual-package hazard does not apply because these packages hold no cross-instance
mutable state (the one registry is created by the consumer, not a module singleton).

The shared preset is `packages/config/tsup.base.mjs` — **plain JavaScript**, listed in
§6, with `splitting: true` for the reason given in §7.1. It is `.mjs` and not `.ts`
because tsup's config loader treats a bare specifier resolving into `node_modules` as
external and hands Node a `.ts` file: `ERR_UNKNOWN_FILE_EXTENSION`, in the one package
every other package's build depends on.

No `publishConfig` anywhere: nothing is published, packages are `private`, so
`main`/`types`/`exports` point straight at `dist` with no publish-time rewrite.

**The consumer side of the dev loop.** `tsup --watch` rebuilds a package in ~50 ms, but
nothing restarts the *consumer*: `nest start --watch` watches `apps/api/src`, and Next's
dev server does not reliably invalidate changed files inside `node_modules`. The failure
mode is nasty because it looks like nothing: you edit an IR type in `schema-model`, tsup
rebuilds, the api keeps serving the old code, and your editor's typecheck disagrees with
the running process. Both consumers are therefore wired explicitly:

- **`apps/api`** — `nest-cli.json` adds the built output to the watch set, so a package
  rebuild restarts the api:
  ```jsonc
  { "compilerOptions": { "watchAssets": true },
    "watchOptions": { "watchFile": "dynamicPriorityPolling" },
    "sourceRoot": "src",
    "monorepo": false,
    "entryFile": "main" }
  ```
  plus `"dev": "nest start --watch --watch-dir ../../node_modules/.pnpm/@schemaloom*"`
  is fragile under isolated linking, so the reliable form is `nodemon` with
  `watch: ["src", "node_modules/@schemaloom/*/dist"]` calling `nest start`. **Use the
  nodemon form.** It is three lines in `apps/api/package.json` and it works the same on
  Windows.
- **`apps/web`** — `next.config.ts` sets `transpilePackages: ['@schemaloom/ui',
  '@schemaloom/engine-postgresql-ui', '@schemaloom/engine-sdk', '@schemaloom/contracts',
  '@schemaloom/schema-model', '@schemaloom/engine-postgresql']`. Next then follows those
  packages through its own module graph and hot-reloads on a `dist` change.

This costs six lines and saves the afternoon somebody would otherwise spend debugging
stale output and concluding "just restart everything on every edit" — which throws away
the entire benefit of the `dev` task graph.

### 9.2 No TypeScript project references

Project references exist to give `tsc` incremental build ordering. Turborepo already
provides build ordering (`^build`) *and* cross-machine caching, and tsup emits the
`.d.ts` that references would have produced. Adding references means maintaining a
second, parallel dependency graph in `tsconfig.json` files that must be kept in sync
with `package.json` by hand — a known drift source and pure duplication.

So: each package has a standalone `tsconfig.json` extending a preset, `typecheck` is
`tsc --noEmit`, and Turborepo guarantees dependency `.d.ts` exist first.

### 9.3 Presets in `packages/config/tsconfig/`

`base.json` — shared strictness:

```jsonc
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2023"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "allowUnreachableCode": false,
    "isolatedModules": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "useDefineForClassFields": true
  }
}
```

Deliberately **not** enabled: `exactOptionalPropertyTypes` (fights Prisma's
`field?: T | null` outputs and React prop spreading; the churn buys little given
`strictNullChecks` is on) and `noPropertyAccessFromIndexSignature` (every `env[...]`
access becomes noisy while `config/env.ts` already produces a typed object).
Revisit both once the codebase exists — noted in Open questions.

`library.json` (all `packages/*`, consumed by tsup):

```jsonc
{
  "extends": "./base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "verbatimModuleSyntax": true,
    "noEmit": true
  }
}
```

`nest.json` (`apps/api`):

```jsonc
{
  "extends": "./base.json",
  "compilerOptions": {
    "module": "Node16",
    "moduleResolution": "Node16",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "strictPropertyInitialization": false,
    "verbatimModuleSyntax": false,
    "useDefineForClassFields": false,
    "outDir": "./dist",
    "declaration": false,
    "sourceMap": true,
    "incremental": true
  }
}
```

Four deliberate deviations, each with a reason:
- `Node16`/`Node16` (not `node`) so package `exports` maps are honoured — §7.1 depends
  on this. `apps/api/package.json` has no `"type"` field, so it stays CommonJS and
  resolves the `require` condition of our dual-format packages.
- `verbatimModuleSyntax: false` because it erases `import type` at emit, which
  destroys the runtime class references `emitDecoratorMetadata` needs for Nest DI.
- `strictPropertyInitialization: false` because Nest DTO classes are populated by the
  validation pipe, not by a constructor.
- `useDefineForClassFields: false`, overriding `base.json`. With it on, a
  declared-but-uninitialised class field — the normal shape of a Nest DTO under
  `strictPropertyInitialization: false` — is emitted as a real `[[Define]]` that
  initialises the property to `undefined`, shadowing prototype accessors and
  interacting badly with the legacy property decorators `experimentalDecorators`
  enables. Cheap to rule out now, tedious to diagnose later. It stays `true` in
  `library.json` and `next.json`, which have no decorators.

`next.json` (`apps/web`):

```jsonc
{
  "extends": "./base.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "verbatimModuleSyntax": true,
    "jsx": "preserve",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "noEmit": true,
    "allowJs": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  }
}
```

`@/*` is the only path alias in the repo. Cross-package imports always use the
package name, never a relative `../../packages/...` path.

### 9.4 Tailwind

Tailwind v4, CSS-first. There is **no `tailwind.config.ts`** anywhere. Tokens live in
`packages/config/tailwind/theme.css` (`@theme` block + Radix Colors scales + the
light/dark `:root` / `.dark` variable sets). `apps/web/src/app/globals.css`:

```css
@import 'tailwindcss';
@import '@schemaloom/config/tailwind/theme.css';

/* v4 needs to be told to scan sibling workspace packages for class names */
@source '../../../../packages/ui/src';
@source '../../../../packages/engines/postgresql-ui/src';
```

`packages/ui` therefore ships **no CSS at all** — just TSX using the shared token
class names. One stylesheet, one build, no per-package PostCSS.

---

## 10. Local infrastructure — `docker-compose.yml`

Only stateful services run in Docker. `apps/web` and `apps/api` run on the host via
`pnpm dev` — faster restarts, working debuggers, and it avoids bind-mount filesystem
performance and file-watching problems (acutely so on Windows, which is the primary
dev platform here).

```yaml
name: schemaloom

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-schemaloom}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-schemaloom}
      POSTGRES_DB: ${POSTGRES_DB:-schemaloom}
    ports:
      - '${POSTGRES_PORT:-5432}:5432'
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test:
        - CMD-SHELL
        - 'pg_isready -U ${POSTGRES_USER:-schemaloom} -d ${POSTGRES_DB:-schemaloom}'
      interval: 5s
      timeout: 3s
      retries: 20

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ['redis-server', '--appendonly', 'yes', '--maxmemory-policy', 'noeviction']
    ports:
      - '${REDIS_PORT:-6379}:6379'
    volumes:
      - redis-data:/data
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 20

  minio:
    image: minio/minio:latest
    restart: unless-stopped
    command: ['server', '/data', '--console-address', ':9001']
    environment:
      MINIO_ROOT_USER: ${S3_ACCESS_KEY_ID}
      MINIO_ROOT_PASSWORD: ${S3_SECRET_ACCESS_KEY}
    ports:
      - '${MINIO_PORT:-9000}:9000'
      - '${MINIO_CONSOLE_PORT:-9001}:9001'
    volumes:
      - minio-data:/data
    healthcheck:
      test: ['CMD', 'mc', 'ready', 'local']
      interval: 5s
      timeout: 3s
      retries: 20

  mailpit:
    image: axllent/mailpit:latest
    restart: unless-stopped
    environment:
      MP_MAX_MESSAGES: 500
      MP_SMTP_AUTH_ACCEPT_ANY: 1
      MP_SMTP_AUTH_ALLOW_INSECURE: 1
    ports:
      - '${MAILPIT_SMTP_PORT:-1025}:1025'
      - '${MAILPIT_UI_PORT:-8025}:8025'

volumes:
  postgres-data:
  redis-data:
  minio-data:
```

| Service | Host ports | Used for |
|---|---|---|
| `postgres` 16 | 5432 | The application database: users, orgs, projects, entities/fields/links, docs, grants, snapshots. Not the database being *modelled* — SchemaLoom never connects to a user's database in Phase 1. |
| `redis` 7 | 6379 | `PermissionResolver` effective-permission cache + invalidation, rate limiting, BullMQ queues (export render, email, DDL import apply), and the Socket.IO adapter from Phase 4. `noeviction` because losing a queue job silently is worse than an OOM error — **safe only because §4.4 requires an explicit TTL on every cache and rate-limit key**, so nothing on this instance grows without bound. One instance, three clients, three key prefixes (§4.4); not three containers. |
| `minio` | 9000 (S3 API), 9001 (console) | S3-compatible object storage for avatars and generated export files. `StorageModule.ensureBucket()` creates the bucket at boot, so there is no bucket-provisioning sidecar container. |
| `mailpit` | 1025 (SMTP), 8025 (web UI) | Catches every outgoing email in dev — verification, magic link, password reset, invites. The `MailModule` SMTP provider points here when Mailgun is not configured. |

**Credentials and ports both come from `.env`, never from literals.** An earlier draft
hardcoded `POSTGRES_USER/PASSWORD/DB` and the MinIO root pair while the api read a
separately hand-written `DATABASE_URL`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` —
so Key decision 15's "they cannot drift apart" was simply false, and the first password
change would produce `password authentication failed` against a container still holding
the old one. Every credential is now interpolated from the same file the api reads, and
the five new variables are in §11.1 and `.env.example`.

Two consequences worth stating rather than discovering:

- **`DATABASE_URL` is derived, not hand-written.** Prisma wants one string, so
  `src/config/env.ts` composes it from `POSTGRES_USER`/`PASSWORD`/`DB`/`POSTGRES_PORT`
  with a `.transform` whenever `DATABASE_URL` is unset. The parts are the source of
  truth; setting the string explicitly is an escape hatch for a managed database, and
  the only way to make the two disagree is to use it.
- **Credential changes are init-only.** Postgres reads `POSTGRES_PASSWORD` and MinIO
  reads `MINIO_ROOT_*` only when the data volume is first created. Changing them in
  `.env` requires `docker compose down -v` — editing compose does not fix a running
  volume. This is a one-line README note and a five-minute confusion otherwise.

**No `POSTGRES_INITDB_ARGS`.** An earlier draft set
`--locale-provider=icu --icu-locale=en-US` with the comment "deterministic collation so
sort order matches CI and prod". Dropped: it is applied by `initdb` only on first volume
creation (so it is silently false for everyone who already has a volume), the ICU path on
`postgres:16-alpine` wants an accompanying `--locale` and burns an hour on first
`compose up`, and Open question 5 means there is no production database whose collation
there is anything to match. Re-add it — with an explicit init-only warning — when a
production Postgres is chosen.

Notes:
- The **test database** is a second database on the same server, created by the
  integration-test global setup (`CREATE DATABASE schemaloom_test` guarded by a
  `pg_database` lookup), not by an init-script volume. `schemaloom_e2e` is created the
  same way by the Playwright global setup (§12). Keeps compose self-contained.
- Pin `minio` and `mailpit` to explicit release tags before wiring CI; `latest` is
  acceptable only for local dev.
- No `adminer`/`pgadmin` service: `psql`, Prisma Studio and an IDE database tool
  already cover it.

---

## 11. Environment variables

One file a human edits: **`.env` at the repo root** (gitignored), with `.env.example`
committed beside it. `docker-compose.yml` reads it natively. `apps/api` loads it with
`ConfigModule.forRoot({ envFilePath: ['../../.env'], isGlobal: true, validate })`.
The Prisma CLI is the one tool that cannot look upward, so `apps/api`'s db scripts run
through `dotenv-cli` (a devDependency, ~40 kB):

```jsonc
"db:generate": "prisma generate",
"db:migrate":  "dotenv -e ../../.env -- prisma migrate dev",
"db:deploy":   "dotenv -e ../../.env -- prisma migrate deploy",
"db:seed":     "dotenv -e ../../.env -- tsx prisma/seed.ts",
"db:studio":   "dotenv -e ../../.env -- prisma studio"
```

### 11.1 `apps/api`

| Variable | Req. | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | no | `development` | Also decides the default for `COOKIE_SECURE`. |
| `PORT` | no | `3001` | HTTP listen port. |
| `API_PUBLIC_URL` | **yes** | — | Absolute base URL of the API. Used to build OAuth callback URLs. |
| `WEB_PUBLIC_URL` | **yes** | — | Absolute base URL of the web app. Used in every email link and every post-OAuth redirect; also the default CORS origin. |
| `CORS_ORIGINS` | no | `WEB_PUBLIC_URL` | Comma-separated allow-list. |
| `POSTGRES_USER` | no | `schemaloom` | Read by **compose** and by `DATABASE_URL` derivation (§10). |
| `POSTGRES_PASSWORD` | no | `schemaloom` | Same. Init-only in the container — see §10. |
| `POSTGRES_DB` | no | `schemaloom` | Same. |
| `POSTGRES_PORT` | no | `5432` | Host port; also feeds the derived `DATABASE_URL`. |
| `DATABASE_URL` | no | derived | Postgres connection string (Prisma). Composed from the four variables above when unset, so the parts cannot drift from the string. |
| `DATABASE_URL_TEST` | no | — | Required only by `test:int`. |
| `REDIS_URL` | **yes** | — | Cache, rate limit, BullMQ. |
| `REDIS_URL_TEST` | no | — | Required only by `test:int`. A **different logical DB** (`redis://localhost:6379/1`) so integration tests never share a keyspace or a queue with the developer's running api. |
| `REDIS_KEY_PREFIX` | no | `sl:` | Prefixed onto every key by all three clients (§4.4). `sl-test:` under `test:int`, `sl-e2e:` under `test:e2e`. |
| `JWT_ACCESS_SECRET` | **yes** | — | ≥32 chars. Signs short-lived access tokens. |
| `JWT_REFRESH_SECRET` | **yes** | — | ≥32 chars. Distinct from the access secret so a leak of one does not mint the other. |
| `ACCESS_TOKEN_TTL` | no | `15m` | |
| `REFRESH_TOKEN_TTL` | no | `30d` | |
| `SECRETS_ENCRYPTION_KEY` | **yes** | — | 32-byte base64. Encrypts TOTP secrets and recovery codes at rest. |
| `COOKIE_DOMAIN` | no | unset | `.schemaloom.dev` in prod. **Applied only to `sl_presence` and `sl_csrf`** — never to `sl_access`, `sl_refresh` or `sl_session`, which are host-only on the API origin (§5.4). Unset locally. |
| `COOKIE_SECURE` | no | `NODE_ENV==='production'` | |
| `CSRF_SECRET` | **yes** | — | HMAC key for the `sl_csrf` double-submit token issued by `AuthModule` and verified by the middleware in §4.5. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | — | Both-or-neither; the Google strategy registers only when both are present, and `GET /engines`-style capability reporting tells the UI which buttons to show. |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | — | Same pattern. |
| `MAIL_FROM` | **yes** | — | e.g. `SchemaLoom <no-reply@schemaloom.dev>`. |
| `MAILGUN_API_KEY`, `MAILGUN_DOMAIN` | no | — | Both-or-neither. When present, `MailModule` binds `EmailProvider` to Mailgun's HTTP API. (Replaced Resend, 2026-09-29.) |
| `MAILGUN_API_URL` | no | `https://api.mailgun.net` | `https://api.eu.mailgun.net` for an EU-region domain. |
| `SMTP_URL` | no | — | When Mailgun is not configured, must be set; locally `smtp://localhost:1025` (mailpit). Boot fails if neither is set. |
| `S3_ENDPOINT` | **yes** | — | `http://localhost:9000` locally. |
| `S3_BUCKET` | **yes** | — | `schemaloom` locally. |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | **yes** | — | Also read by **compose** as MinIO's root credentials (§10), so they cannot drift. |
| `S3_PUBLIC_URL` | no | `S3_ENDPOINT` | Base URL handed to browsers for presigned GETs. |
| `LOG_LEVEL` | no | `info` | pino level. |
| `ANTHROPIC_API_KEY` | no | — | Phase 2. Optional in Phase 1; the AI module is not registered without it. |

**Five rows deliberately deleted** (C12 asks for over-built things to be named, and a
knob that never turns is configuration for a constant):

| Was | Now |
|---|---|
| `S3_REGION` | `const S3_REGION = 'us-east-1'` in `storage/`. MinIO ignores it; a single-region AWS deployment sets it once, in code, when there is one. |
| `S3_FORCE_PATH_STYLE` | `const` `true`. The document itself said it is required by MinIO and harmless on AWS — that is the definition of a constant. |
| `RATE_LIMIT_WINDOW_SEC` / `RATE_LIMIT_MAX` | `const` defaults next to the limiter. Every meaningful limit is a per-route override in code already; a global default nobody tunes is a row. |
| `TOTP_ISSUER` | `const 'SchemaLoom'`. It is the product name. |

Kept as env because ops would plausibly change them mid-incident: `LOG_LEVEL`,
`ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL`, `CORS_ORIGINS`.

### 11.2 `apps/web`

| Variable | Req. | Default | Purpose |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | **yes** | — | Browser-side API base. Inlined at build time, so it is listed in `turbo.json`'s `build.env`. |
| `NEXT_PUBLIC_APP_URL` | no | — | Canonical/absolute-URL generation. |
| `API_INTERNAL_URL` | no | `NEXT_PUBLIC_API_URL` | Server-component fetches; lets RSC talk to the API over a private network address in prod. **Server-only, read lazily** — see §11.4. |
| `PORT` | no | `3000` | |

### 11.3 `e2e`

Previously missing entirely, which meant a developer following §11 as "the complete
environment contract" could not run the suite at all.

| Variable | Req. | Default | Purpose |
|---|---|---|---|
| `E2E_BASE_URL` | no | `http://localhost:3000` | Playwright `baseURL`; also the `webServer` readiness URL for the web app. |
| `E2E_API_URL` | no | `http://localhost:3001` | Direct API calls from fixtures (seeding, token minting) and the api `webServer` readiness URL. |
| `DATABASE_URL_E2E` | **yes** | — | The **dedicated, disposable** e2e database. Global setup creates, migrates, seeds and drops it. Never `DATABASE_URL`. |
| `REDIS_KEY_PREFIX` | no | `sl-e2e:` | Set by the `test:e2e` script, so an e2e run cannot touch a dev queue or cache. |

All four are in `.env.example`, as are the five compose credentials from §10 and
`REDIS_URL_TEST`/`DATABASE_URL_TEST`. `.env.example` is the complete list; if a variable
is not in it, no task may read it.

### 11.4 Validation at boot

Two small zod schemas, no library:

- **api** — `src/config/env.ts` exports `envSchema` and `type AppEnv`. `ConfigModule`'s
  `validate` hook runs `envSchema.parse(raw)`; a failure throws before the Nest
  container is built, so the process exits with the list of offending variables
  instead of a `undefined is not a function` twenty seconds later. Cross-field rules
  live in the same schema as `.superRefine` (e.g. "Mailgun or `SMTP_URL`",
  "Google id and secret are both-or-neither", "`COOKIE_SECURE` must be true when
  `NODE_ENV==='production'`"), as does the `DATABASE_URL` derivation from §10.
- **web** — **two modules, not one**, because they are needed at different times:
  - `src/env.client.ts` parses the `NEXT_PUBLIC_*` schema eagerly at module load. It is
    the **only** env module `next.config.ts` imports, so `next build` still fails fast
    on a missing public variable and `turbo.json`'s `build.env`
    (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_URL`) remains an honest description of what
    the build reads.
  - `src/env.ts` holds the server schema and parses **lazily on first access**
    (`export const serverEnv = () => cached ??= serverSchema.parse(process.env)`), so a
    server variable is required at *runtime*, not at build time. The earlier
    parse-everything-at-module-load version forced CI to supply `API_INTERNAL_URL` merely
    to produce a bundle, and made `build.env` a lie.

  The client object only ever contains `NEXT_PUBLIC_*` keys, which is what stops a
  server secret being bundled.

Skipped: `@t3-oss/env-nextjs`. Two 30-line zod schemas do the same job with no
dependency and no framework coupling.

---

## 12. Tests — where they live

| Kind | Location | Runner | Needs services |
|---|---|---|---|
| Unit | `*.spec.ts(x)` co-located next to the file under test, in every package and app | Vitest | no |
| Engine conformance | Suite in `packages/engine-sdk/src/conformance/`, **invoked** from each engine: `packages/engines/postgresql/src/conformance.spec.ts` | Vitest (plain devDependency) | no |
| Integration (api) | `apps/api/test/integration/**/*.int.spec.ts` | Vitest, `vitest.integration.config.ts` | Postgres + Redis (both **test-only** — §12.1) |
| E2E | `e2e/tests/**/*.spec.ts`, fixtures in `e2e/fixtures/`, page objects in `e2e/pages/` | Playwright | full stack + its own `schemaloom_e2e` DB (§12.2) |

**One runner across the monorepo: Vitest.** Including `apps/api` — Nest's
`@nestjs/testing` works under Vitest with `unplugin-swc` handling decorators and
`emitDecoratorMetadata`. Running Jest in the api and Vitest everywhere else would mean
two configs, two mocking APIs and two coverage formats for no gain.

`packages/config/vitest.base.mjs` holds the shared config (globals off, coverage
provider `v8`, `environment: 'node'`); `apps/web` overrides `environment: 'jsdom'`.
`.mjs` for the same reason as `tsup.base.mjs` (§6).

The conformance suite lives in `engine-sdk` (not in a separate `engine-testkit`
package) and is reached through the `./conformance` subpath. **`vitest` is a plain
devDependency of `engine-sdk`, not an optional peer.** Nothing is published, every
consumer is in this repo and already has vitest, `./conformance` is only ever imported
from a `*.spec.ts` that no runtime bundle includes, and `sideEffects: false` plus
per-entry resolution already keep it out of any shipped graph. A peer entry bought
nothing and made the manifest look like the package has a plugin contract it does not
have. `external: ['react', 'vitest']` stays in the tsup config.

A new engine's entire test obligation is one file (§6.2 — the engine supplies its own
native fixtures, because a `.sql` fixture is not engine-neutral):

```ts
// packages/engines/<x>/src/conformance.spec.ts
import { runEngineConformance } from '@schemaloom/engine-sdk/conformance';
import { xEngine } from './index';
import { fixtures } from './__fixtures__';

runEngineConformance(xEngine, fixtures);
```

### 12.1 Integration-test isolation — one rule, stated

"Migrate the test DB, truncate between tests" plus Vitest's default file-level
parallelism is a race, not a strategy: Vitest runs `*.int.spec.ts` files concurrently in
separate workers against one database, and worker A's truncate deletes the fixtures
worker B just inserted mid-assertion. It fails roughly one run in five, differently each
time, and the fix applied under deadline pressure is `retry: 2`, which hides it forever.

**Phase 1 rule: `vitest.integration.config.ts` sets `fileParallelism: false`.**

```ts
export default defineConfig({
  test: {
    include: ['test/integration/**/*.int.spec.ts'],
    globalSetup: ['test/setup/global.ts'],   // create + migrate schemaloom_test
    setupFiles: ['test/setup/truncate.ts'],  // TRUNCATE … RESTART IDENTITY CASCADE per test
    fileParallelism: false,
    hookTimeout: 30_000,
  },
});
```

Simplest, correct, and slow — the honest Phase 1 choice, since there are maybe thirty
integration tests. The upgrade path, when wall-clock actually hurts, is one Postgres
*schema* per worker seeded from a template and selected via `VITEST_WORKER_ID` in the
connection `search_path`; that is a change to `test/setup/` and nothing else. Do not
reach for it first, and do not reach for `retry` ever.

Redis isolation is orthogonal and already covered: `REDIS_URL_TEST` on logical DB 1 plus
`REDIS_KEY_PREFIX=sl-test:` (§4.4, §8.2).

### 12.2 E2E wiring — database, servers, and the guard that prevents the accident

**Database.** `e2e/global-setup.ts` owns `schemaloom_e2e` end to end: create if absent,
`prisma migrate deploy`, `db:seed`, and truncate-and-reseed between suites. It reads
`DATABASE_URL_E2E` and **refuses to run — throws before Playwright starts — unless the
database name in that URL ends in `_e2e`.** One assertion, and the class of bug where a
seeding suite truncates someone's working database becomes impossible rather than
unlikely.

**Servers.** Playwright starts both apps itself, so `pnpm test:e2e` behaves the same on
a laptop and in CI:

```ts
// e2e/playwright.config.ts
export default defineConfig({
  testDir: './tests',
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000' },
  globalSetup: './global-setup.ts',
  webServer: [
    {
      command: 'pnpm --filter @schemaloom/api start:prod',
      url: `${process.env.E2E_API_URL ?? 'http://localhost:3001'}/healthz`,
      reuseExistingServer: !process.env.CI,
      env: { DATABASE_URL: process.env.DATABASE_URL_E2E!, REDIS_KEY_PREFIX: 'sl-e2e:' },
    },
    {
      command: 'pnpm --filter @schemaloom/web start',
      url: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
```

Both are **production** starts, not `dev` — which is why `test:e2e` depends on the two
`#build` tasks (§8.2) and why running it against unbuilt apps is now impossible rather
than merely discouraged. `reuseExistingServer: !process.env.CI` lets a developer keep
`pnpm dev` running.

**Shared types.** Seed payload shapes live in `packages/contracts` (`fixtures.ts` — they
describe API payloads anyway) and the seed *helpers* in `e2e/fixtures/`. `e2e` depends on
`@schemaloom/contracts` and on neither app: the apps are `private: true` with no
`exports` field and are not importable even deliberately.

Spec-mandated suites and their homes:
- Permission matrix (every org role × resource role × atom × inheritance case) →
  `apps/api/src/access/permission-resolver.spec.ts` (pure unit — the resolver takes a
  grant set as input, no DB).
- DDL → IR → DDL round-trip → part of the conformance suite, with Postgres-specific
  fixtures additionally in `packages/engines/postgresql/src/importer/*.spec.ts`.
- Key workflows (spec §8, all five) → `e2e/tests/`.

---

## 13. Phase 1 vs later

"Populated" = has real code on day one. "Stub" = the directory exists with a single
placeholder so the routing/registration shape is visible. "Absent" = do not create it.

| Path | Phase 1 | Notes |
|---|---|---|
| `apps/api/src/{config,common,prisma,redis,health}` | Populated | Boot plumbing. |
| `apps/api/src/{auth,users,orgs,workspaces,projects,schema,docs,engines,access,transfer,mail,storage,jobs,audit}` | Populated | §4. `access` ships built-in roles + project-level grants only. |
| `apps/api/src/{ai,realtime,comments,history,notifications,search}` | **Absent** | P2/P4/P5. |
| `apps/api/prisma/{schema.prisma,migrations,seed.ts}` | Populated | Full model per doc 02, including tables only used from P2 onward — the data model must already accommodate later phases (spec §11). |
| `apps/web/src/app/(auth)/**` | Populated | All routes listed in §5. |
| `apps/web/src/app/(app)/[orgSlug]/{page,settings/general,settings/members}` | Populated | |
| `apps/web/src/app/(app)/[orgSlug]/settings/groups` | Stub | Route exists, renders a "Phase 3" empty state. |
| `apps/web/src/app/(app)/[orgSlug]/w/[workspaceSlug]`, `p/[projectId]/{layout,page,settings}` | Populated | |
| `apps/web/src/app/(app)/[orgSlug]/p/[projectId]/docs` | **Absent** | Docs *mode* is P5. The docs *panel* (P1) is `features/docs-panel`, not a route. |
| `apps/web/src/app/(share)` | **Absent** | P3. Reserved name only. |
| `apps/web/src/app/(marketing)` | **Absent** | No landing page yet. |
| `apps/web/src/app/api/` | **Absent — permanently** | §5.4: the browser calls the API directly. |
| `apps/web/src/features/{canvas,inspector,docs-panel,transfer,projects,auth}` | Populated | |
| `apps/web/src/features/{ai,comments,presence,history}` | **Absent** | P2/P4. |
| `apps/web/src/engines/**` | Populated | Registry + the single Postgres registration. |
| `packages/schema-model` | Populated | IR types + `diff/`. `diff/` is P1 even though snapshots are P4: the importer needs it to report "what would change". |
| `packages/engine-sdk` (`.`, `/ui`, `/conformance`) | Populated | `migrationGenerator`, `queryValidator` and `aiProfile` are declared in the interface and **optional** on `EngineDefinition` in P1, implemented for Postgres in P2/P4. |
| `packages/contracts` | Populated | One folder per api module that has routes — including `access/`, `users/` and `engines/`, without which those three modules' `dto/` convention would be dangling on day one. `fixtures.ts` holds the e2e seed payload shapes. `ai/`, `comments/` absent (P2/P4). |
| `packages/engines/postgresql` — `static/`, `importer/`, `exporter/` | Populated | |
| `packages/engines/postgresql` — `migration/`, `query-validator/`, `ai-profile/` | **Absent** | P4, P2, P2. |
| `packages/engines/postgresql-ui` | Populated | |
| `packages/engines/mysql`, `mongodb`, … | **Absent** | The value of this layout is that adding one is a new folder plus a `pnpm add`, with no core edits. |
| `packages/ui` | Populated | Only the primitives the P1 screens use; do not pre-build a component catalogue. |
| `packages/config` | Populated | JS + JSON only, never TypeScript (§6). No build script. |
| `e2e` | Populated | The five spec §8 workflows, minus the ones whose features are later-phase (workflows 2–4 land with P3 sharing). P1 ships workflow 1 and 5-without-migrations. Depends on `contracts` only; `playwright.config.ts` + `global-setup.ts` per §12.2. |
| Export: DDL / JSON / Markdown / SVG / PNG | Populated | §4.3. SVG+PNG are client-rendered and uploaded; the api has no headless browser. |
| Export: documentation as PDF | **Absent** | P5, with docs mode. Deferred, not dropped — spec §6.4 asks for it. Markdown → PDF in the api; still no browser needed. |
| `.github/workflows/ci.yml` | Populated | §8.3 — `static` / `integration` / `e2e` jobs, service containers for Postgres+Redis, no Turborepo remote cache in Phase 1. |
| `apps/worker` | **Absent** | BullMQ processors run in the api process until a queue actually needs independent scaling. |
| `packages/emails` | **Absent** | Templates live in `apps/api/src/mail/templates` until there are enough to hurt. |
| `infra/`, `helm/`, `terraform/` | **Absent** | No deployment target chosen yet. |

---

## Key decisions

1. **Compiled packages (tsup → `dist`, ESM+CJS+d.ts) rather than source-first
   workspace packages.** NestJS's compiler is the constraint: consuming raw `.ts` from
   `node_modules` requires abandoning `rootDir` or bolting on a custom builder, while
   Turborepo already caches `dist/` so the build cost is paid once.
2. **`packages/config` is JavaScript and JSON only, and is the one package with no
   build.** A `tsup.base.ts` cannot be loaded by tsup's own config loader out of
   `node_modules`; the package every other build depends on must not need building.
3. **Consumer-side dev watching is wired explicitly** — nodemon watching
   `node_modules/@schemaloom/*/dist` for the api, `transpilePackages` for the web app.
   Without it `tsup --watch` rebuilds into a process that never reloads, and the `dev`
   task graph's whole benefit is traded for "restart everything on every edit".
4. **No TypeScript project references.** Turborepo's `^build` graph plus tsup's `.d.ts`
   output already provide ordering and incrementality; references would duplicate the
   dependency graph in a second set of files that drifts.
5. **`@schemaloom/engine-sdk` splits into `.`, `./ui` and `./conformance`, with `react`
   as an optional peer and `vitest` as a plain devDependency.** `./ui` re-exports the
   type-only surface browser code needs (§6.1), so the capability gating spec §3.3
   mandates is implementable without reaching the `.` entry.
6. **`@schemaloom/engine-postgresql` also splits, into `.` and `./static`, built with
   `splitting: true` and a preserved dynamic `import()`.** The browser needs the type
   catalog and props schemas but not `libpg-query`; shared chunking keeps one identity
   per schema object across entries, and `supported: { 'dynamic-import': true }` stops
   esbuild rewriting the lazy WASM import into a `require()` that throws on Node 22.
7. **`postgresql-ui` stays a separate package**, not a third subpath. It depends on
   `@schemaloom/ui` *at runtime*; as a subpath, that dependency would land in
   `apps/api`'s closure and put React back into the backend's `node_modules` — the exact
   property decision 8 exists to guarantee. An earlier draft left this open; it is decided
   here and is no longer an open question.
8. **The React boundary is `node-linker=isolated` + `apps/api` not declaring react.**
   Not `strict-peer-dependencies`, which ignores optional peers and would hard-fail the
   first install on an unrelated lagging peer range. That flag has been removed.
9. **Browser talks to the API directly; no Next proxy, no route handlers, no Server
   Actions.** Web and api are same-site in every environment, so cookies work as-is; a
   proxy would add a hop, duplicate auth and break the Phase 4 WebSocket upgrade.
10. **Presence is split from authority: `sl_access`/`sl_refresh` are host-only on the
    API origin; a valueless `sl_presence` cookie carries `COOKIE_DOMAIN`.** Middleware
    only needs "is someone signed in", so no subdomain ever receives a refresh token.
11. **Two `APP_GUARD`s in a fixed order (`JwtAuthGuard` → `PermissionGuard`), five explicit
    route markers with no implicit default, and a boot-time sweep that asserts every route
    carries exactly one marker *and* is classified against the share-link allow-list.**
    "Every route protected" becomes a startup failure rather than a review checklist, and a
    new surface cannot silently become a public-link leak.
12. **CSRF has a named owner:** `AuthModule` issues `sl_csrf` (non-httpOnly by design),
    a global middleware verifies it on every unsafe method, `api-client.ts` echoes it.
13. **Engines are registered from a one-line manifest consumed by a multi-provider
    token; `EngineRegistry` *is* the SDK's `createEngineRegistry()` wrapped once.**
    Adding an engine touches one file that is not part of `EnginesModule`. The deviation
    from the spec's literal "engines register themselves" is stated in §4.2.
14. **`GET /engines` returns `registry.catalog()` — `{ available, comingSoon }` — with the
    announcement list a server-side constant passed into `createEngineRegistry`.** The
    registry derives status by set difference, so a registration always wins, the picker stays
    registry-driven, and `EngineDefinition` needs no `status` field.
15. **The conformance suite takes native fixtures from the engine; doc 03 owns the check
    list.** A `.sql` fixture inside an engine-neutral SDK breaks at the first non-SQL engine —
    which is the first real test of the whole plugin architecture. The entry point is
    `runEngineConformance(engine, fixtures)`, one file per engine package.
16. **The IR is fetched by the canvas route, not dehydrated into the project layout.**
    At 300+ entities a layout-level dehydration inlines megabytes into the HTML on every
    navigation, including `/settings`. Redaction is server-side either way.
17. **`RedisModule` exposes three distinct ioredis clients from one factory, every cache
    and rate-limit key carries a TTL, and the rate limiter fails closed.** BullMQ's
    blocking reads cannot share a socket with cache commands, and `noeviction` is safe
    only if nothing on the instance grows without bound.
18. **`test:e2e` depends on `@schemaloom/api#build` and `@schemaloom/web#build`, starts
    both apps via Playwright `webServer`, and reads `DATABASE_URL_E2E` guarded by an
    `_e2e` suffix check.** Turborepo expresses the cross-package dependency fine; the
    earlier `^build` on a package with no workspace dependencies ordered nothing.
19. **`test:int` reads `REDIS_URL_TEST` (a separate logical DB) and every client carries
    `REDIS_KEY_PREFIX`.** Sharing Redis with a running `pnpm dev` api means tests enqueue
    jobs the dev process then executes — two weeks of "flaky tests".
20. **`fileParallelism: false` for integration tests.** Concurrent workers truncating one
    shared database is a race; the honest Phase 1 answer is serial, not `retry: 2`.
21. **CI is three jobs with Postgres/Redis service containers, `migrate deploy` before
    `test:int`, and no Turborepo remote cache in Phase 1.** Compose is dev-only, so
    without service containers `test:int` cannot run in CI at all.
22. **`test` is unit-only and cacheable; integration and e2e are uncached.** A task whose
    result depends on external database state must not be cached, and the fast inner loop
    must not require Docker.
23. **Vitest everywhere, including NestJS** (via `unplugin-swc`). One runner, one config
    preset, one coverage format.
24. **Tailwind v4, CSS-first, no `tailwind.config.ts`; tokens in
    `packages/config/tailwind/theme.css` with `@source` pointing at sibling packages.**
    One stylesheet and one build for the whole workspace.
25. **`nestjs-zod`: one definition per request/response shape.** `createZodDto()` gives
    Nest the class it needs and `patchNestJsSwagger()` makes OpenAPI generate from the
    same zod object, so the published spec cannot drift from what the API accepts.
26. **Prisma's `prisma-client` generator is pinned to `moduleFormat = "cjs"` with output
    in `apps/api/src/generated/prisma`,** excluded from lint and from the type-aware
    tsconfig. Turborepo can only cache outputs inside the package, and the CJS format is
    what prevents `ERR_REQUIRE_ESM` at boot under `module: Node16`.
27. **A single root `.env`, with every compose credential interpolated from it and
    `DATABASE_URL` derived from its parts.** This is what actually makes "they cannot
    drift apart" true — the previous version hardcoded the passwords in compose and the
    guarantee was false.
28. **Only stateful services in Docker; apps run on the host.** Faster restarts, working
    debuggers, and it sidesteps bind-mount file-watching problems on Windows.
29. **No changesets, no versioning, no `publishConfig`.** Every package is private and
    consumed via `workspace:*`; release tooling for a monorepo that publishes nothing is
    pure overhead.
30. **Five env rows deleted in favour of code constants** (`S3_REGION`,
    `S3_FORCE_PATH_STYLE`, `RATE_LIMIT_WINDOW_SEC`, `RATE_LIMIT_MAX`, `TOTP_ISSUER`) and
    three `.npmrc` lines dropped. Configuration for a value that never varies between
    environments is a row in a table nobody reads.

## Open questions

1. **Production topology is assumed, not specified.** I assumed `app.schemaloom.dev` +
   `api.schemaloom.dev` under one registrable domain, because §5.4's CORS and cookie
   design depends on web and api being same-*site*. `COOKIE_DOMAIN` now scopes only
   `sl_presence` and `sl_csrf`, so a different-apex API costs less than it used to — but
   it still means `SameSite=None` on the session cookies and a re-think of middleware
   presence. Please confirm the domain plan before `AuthModule` is written.
2. **"Engines register themselves at startup" (spec §3.2) is not literally
   implementable**, and I have substituted a one-line manifest (§4.2). Literal
   self-registration needs a side-effecting import: invisible, order-dependent,
   tree-shakeable — and still a file someone edits. The property the spec actually wants
   ("no changes to core modules") does hold, because `engines.manifest.ts` is not part of
   `EnginesModule`. Flagged loudly per C12. If you want literal self-registration
   instead, doc 03's `EngineDefinition` grows a registration side effect.
3. **The IR payload size for a 300-entity project must be measured before Phase 1
   closes.** §5.2 moved the fetch off the layout, which fixes the per-navigation cost but
   not the absolute size. If the redacted IR exceeds ~1 MB gzipped, the canvas query has
   to be paginated by area *before* the canvas ships. A measurement, not a decision — but
   it needs an owner, and it constrains doc 04's IR shape.
4. **Do `migrationGenerator`, `queryValidator` and `aiProfile` belong on
   `EngineDefinition` in Phase 1?** They are **optional**, so Phase 1 ships a Postgres engine
   without them and Phases 2/4 fill them in with no interface change, and doc 03's
   `capabilities/services-match-features` check forces `features.migrations` and
   `features.queryValidation` to agree with what is actually present. The alternative —
   required from day one with throwing stubs — makes the conformance suite lie about what an
   engine supports. Doc 03 matches; confirm the phasing.
5. **Hosting target is undecided**, so there is no `infra/` directory, no Dockerfile for
   the apps, and no production collation pinned on Postgres (§10). Vercel-for-web + a
   container host for the api is the obvious default; a single container or VM would mean
   `apps/web` in `standalone` output mode and a changed `next.config.ts`.
6. **BullMQ processors run in the api process.** Fine for Phase 1 (exports and emails),
   but a long DDL import or a Phase 5 AI doc-drafting run will compete with request
   handling. The upgrade is an `apps/worker` importing `JobsModule` and nothing else;
   deciding *when* is a load question, not a design one.
7. **Two strict flags deliberately left off** — `exactOptionalPropertyTypes` and
   `noPropertyAccessFromIndexSignature`. Both cause real friction with Prisma's
   optional-nullable outputs and React prop spreading. Happy to turn them on now rather
   than retrofit, if you prefer the pain up front.
8. **The spec asks for magic link, Google OAuth, GitHub OAuth, TOTP 2FA, recovery codes
   and device-session management all in Phase 1 auth.** That is five login paths before
   there is a single user. Password + email verification + one OAuth provider covers
   every Phase 1 workflow; the rest could land in Phase 3 alongside the sharing work that
   actually needs guest accounts. I have designed the env vars and the module for the
   full set regardless — flagging as requested.
9. **Integration tests are serial (`fileParallelism: false`).** Correct and simple, but
   it puts a ceiling on the suite: thirty tests is fine, three hundred is a coffee break.
   The upgrade (one Postgres schema per worker, seeded from a template, selected via
   `VITEST_WORKER_ID`) is confined to `test/setup/`. Worth agreeing now that the ceiling
   is acceptable, so nobody "fixes" the slowness by re-enabling parallelism and adding
   retries — which restores the race and hides it.
10. **Phase 1 e2e runs Chromium only.** Firefox and WebKit roughly quadruple e2e wall
    clock for a product whose Phase 1 surface is a canvas and some forms. Say if a
    cross-browser matrix is a release requirement rather than a later addition.
11. **No Turborepo remote caching.** Right at this repo size, but if the team grows past
    a few people or CI minutes are billed, a remote cache pays for itself quickly. It is
    a token and a vendor decision, not a design change — revisit when CI passes
    ~10 minutes.
