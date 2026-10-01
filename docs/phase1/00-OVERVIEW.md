# 00 — SchemaLoom Phase 1: consolidated design reference

Assembled from the five Phase 1 design documents after their revision pass.
Source of record for decisions, contracts, outstanding cross-document deltas and
open questions. The five documents remain authoritative for *how*; this file is
authoritative for *what was decided* and *what is still undecided*.

Tags used throughout: `[D01]` repo layout · `[D02]` Prisma schema ·
`[D03]` engine SDK · `[D04]` schema-model IR · `[D05]` permissions.

---

## 1. Orientation

SchemaLoom is a multi-tenant schema-design product built as a pnpm/Turborepo
monorepo with one NestJS API and one Next.js App Router web app. The live schema
of a user's project is **relational** — ten tables, one row per IR object, each
row carrying its own `version` and a denormalised `project_id` — and JSON appears
only inside `engine_props` and `snapshots.ir`. Everything database-vendor-specific
is pushed behind a single plugin seam (`EngineDefinition` + `EngineStaticFacet` +
`EngineUiPlugin`), so adding MongoDB later is a package, not a migration. Rows are
assembled into an engine-neutral in-memory IR (`SchemaModel`), and **every** byte
of schema that leaves the server passes through one redaction function first. That
single path is the security design: the permission model is nine atoms resolved
into a per-subject map, and `VisibilityFilter.redact` is the only exit.

Recommended reading order:

| Order | Document | Read this if you care about |
|---|---|---|
| 1 | `01-repo-layout.md` | where files go, the build/test/CI graph, module wiring, env vars, the guard chain |
| 2 | `02-prisma-schema.md` | the tables, constraints, triggers, migrations, cascade behaviour and indexes you will actually run |
| 3 | `04-schema-model-ir.md` | the IR types, zod schemas, the write-op batch, the diff engine and the redacted shape |
| 4 | `05-permission-resolution.md` | atoms, roles, grants, the resolver algorithm, `VisibilityFilter` and the leak audit |
| 5 | `03-engine-sdk.md` | the plugin contract: capabilities, types, diagnostics, import/export, migration, AI, UI plugin |

Read 01 before anything else; read 02 before 04 (04's row-to-IR mapping assumes
02's columns); read 04 before 05 (05 redacts 04's shapes); read 03 last, because
it consumes types from 04 and rules from 05.

---

## 2. Architecture at a glance

```
                    apps/web (Next.js App Router)
                    ├── (marketing) (app) (auth) route groups
                    ├── canvas: server shell + client store
                    └── EngineUiRegistry ──► @schemaloom/engine-sdk/ui  (types only)
                                        └──► @schemaloom/engine-postgresql/static
                                        └──► @schemaloom/engine-postgresql-ui  (React)
                             │
                             │  direct HTTPS, same-site cookies, no Next proxy
                             ▼
                    apps/api (NestJS)
                    ├── AuthModule ──── sl_access / sl_refresh (host-only)
                    │                   sl_presence / sl_csrf (COOKIE_DOMAIN)
                    │                   sl_session (share-link, signed, stateless)
                    ├── guards:  JwtAuthGuard ──► PermissionGuard      (fixed order)
                    ├── AccessModule: PermissionResolver, VisibilityFilter,
                    │                 SchemaLoader, PermissionGuard
                    ├── EnginesModule ◄── engines.manifest.ts   ◄── THE PLUGIN SEAM
                    │       ENGINE_DEFINITION multi-provider token
                    │       EngineRegistry = createEngineRegistry(defs, announced)
                    ├── RedisModule: REDIS_CACHE / REDIS_RATELIMIT / REDIS_QUEUE
                    └── BullMQ workers (in-process, Phase 1)
                             │
      ┌──────────────────────┴───────────────────────┐
      ▼                                              ▼
 PostgreSQL (10 schema tables + auth/tenancy   Redis (perm maps, skeletons,
 + content + permissions + logs)                rate limits, queues — all TTL'd)
```

### The single path schema data takes out of the server

```
  relational rows                  (02: entities, fields, links, indexes,
  (11 parallel index scans          constraints, custom_types, namespaces,
   on project_id, zero joins)       areas, link_endpoints, index_columns, docs)
        │
        │  assembleModel(AssemblyInput)                                    [D04 §8.1]
        ▼
  RawSchemaModel  ── hash-private payload, throwing toJSON, module-private unwrap
        │           `return raw.ir` does not compile                       [D05 §8.6]
        │
        │  redact(raw, VisibilityContext)   ◄── ProjectPermissionMap + ProjectSkeleton
        │                                       from PermissionResolver    [D05 §8]
        ▼
  RedactedModel = SchemaModel & { redacted: true }                          [D03/D04]
        │
        ├──► REST serializers  ──► interceptor rejects redacted !== true
        ├──► WebSocket frames  ──► assertRedacted called explicitly
        ├──► Exporter.export(RedactedModel)  ──► DDL / JSON / Markdown (server)
        │                                        SVG / PNG (client-rendered)
        ├──► AiProfile.serializeContext(RedactedModel) ──► SCS ──► provider
        └──► QueryValidator.validate(RedactedModel)   ──► restrictedProbe: undefined

  Never on this path: the engine validator (runs server-side on the RAW model,
  diagnostics filtered afterwards) and snapshot restore (project-scoped, raw).
```

---

## 3. Consolidated decision log

138 numbered entries, continuous, grouped by area. Source: the five documents'
own "Key decisions" sections (30 + 25 + 24 + 29 + 30 = 138 items). Six
pairs/triples said the same thing from two or three sides and are **[merged]**
into one entry carrying every tag; the seven slots this frees are filled by
decisions recorded in the documents' revision summaries but missing from their
numbered lists (entries 78, 79, 103, 104, 109, 110, 138). **Nothing was dropped.**

### 3.1 Monorepo & tooling — `[D01]`

1. **Compiled packages (tsup → `dist`, ESM+CJS+d.ts), not source-first.** NestJS's compiler cannot consume raw `.ts` from `node_modules` without abandoning `rootDir`; Turborepo caches `dist/` so the cost is paid once. `[D01#1]`
2. **`packages/config` is JS + JSON only and is the one package with no build.** tsup's own config loader cannot load a `tsup.base.ts` out of `node_modules`. `[D01#2]`
3. **Consumer-side dev watching is wired explicitly** — nodemon on `node_modules/@schemaloom/*/dist` for the api, `transpilePackages` for web. Without it `tsup --watch` rebuilds into a process that never reloads. `[D01#3]`
4. **No TypeScript project references.** `^build` + tsup `.d.ts` already give ordering and incrementality; references duplicate the dependency graph in files that drift. `[D01#4]`
5. **`@schemaloom/engine-sdk` splits into `.`, `./ui`, `./conformance`**, `react` an optional peer, `vitest` a plain devDependency, so spec §3.3 capability gating is implementable without reaching the `.` entry. `[D01#5]`
6. **`@schemaloom/engine-postgresql` splits into `.` and `./static`, `splitting: true`, dynamic `import()` preserved.** The browser needs the type catalog and props schemas, not `libpg-query`; `supported: { 'dynamic-import': true }` stops esbuild rewriting the lazy WASM import into a `require()` that throws on Node 22. `[D01#6]`
7. **`postgresql-ui` is a separate package, not a third subpath.** As a subpath its runtime dependency on `@schemaloom/ui` would land React in `apps/api`'s closure. `[D01#7]`
8. **The React boundary is `node-linker=isolated` + `apps/api` not declaring react** — not `strict-peer-dependencies`, which ignores optional peers and hard-fails install on an unrelated lagging peer. `[D01#8]`
9. **Browser talks to the API directly: no Next proxy, no route handlers, no Server Actions.** Same-site everywhere, so cookies work as-is; a proxy adds a hop, duplicates auth and breaks the Phase 4 WebSocket upgrade. `[D01#9]`
10. **Presence is split from authority.** `sl_access`/`sl_refresh` are host-only on the API origin; a valueless `sl_presence` carries `COOKIE_DOMAIN`, so no subdomain receives a refresh token. `[D01#10]`
11. **Two `APP_GUARD`s in fixed order (`JwtAuthGuard` → `PermissionGuard`), five explicit route markers, no implicit default, and a boot-time sweep** asserting every route carries exactly one marker and is classified against the share-link allow-list. "Every route protected" becomes a startup failure. `[D01#11]`
12. **CSRF has a named owner.** `AuthModule` issues `sl_csrf` (non-httpOnly by design), global middleware verifies on every unsafe method, `api-client.ts` echoes it. `[D01#12]`
13. **Engines register from a one-line manifest consumed by a multi-provider token**; `EngineRegistry` is the SDK's `createEngineRegistry()` wrapped once. Adding an engine touches one file outside `EnginesModule`. Deviation from spec §3.2's literal self-registration is stated. `[D01#13]`
14. **`GET /engines` returns `{ available, comingSoon }` from `registry.catalog()`; "coming soon" is a server-side const and registration always wins, so `EngineDefinition` needs no `status` field.** Status is a property of the deployment, not the engine. **[merged]** `[D01#14 + D03#16]`
15. **The conformance suite takes native fixtures from the engine; doc 03 owns the check list.** A `.sql` fixture inside an engine-neutral SDK breaks at the first non-SQL engine. `[D01#15]`
16. **The IR is fetched by the canvas route, not dehydrated into the project layout.** At 300+ entities layout-level dehydration inlines megabytes into the HTML on every navigation, including `/settings`. `[D01#16]`
17. **`RedisModule` exposes three distinct ioredis clients from one factory; every cache and rate-limit key carries a TTL; the rate limiter fails closed.** BullMQ's blocking reads cannot share a socket with cache commands. `[D01#17]`
18. **`test:e2e` depends on `@schemaloom/api#build` + `@schemaloom/web#build`, starts both via Playwright `webServer`, reads `DATABASE_URL_E2E` guarded by an `_e2e` suffix check.** The earlier `^build` on a package with no workspace deps ordered nothing. `[D01#18]`
19. **`test:int` reads `REDIS_URL_TEST` (separate logical DB) and every client carries `REDIS_KEY_PREFIX`.** Sharing Redis with a running `pnpm dev` api means tests enqueue jobs the dev process executes. `[D01#19]`
20. **`fileParallelism: false` for integration tests.** Concurrent workers truncating one shared database is a race; serial is the honest answer, not `retry: 2`. `[D01#20]`
21. **CI is three jobs (static / integration / e2e) with Postgres 16 + Redis 7 service containers and `prisma migrate deploy` before `test:int`.** Compose is dev-only, so without service containers `test:int` cannot run in CI at all. `[D01#21]`
22. **`test` is unit-only and cacheable; integration and e2e are uncached.** A task depending on external database state must not be cached, and the fast inner loop must not need Docker. `[D01#22]`
23. **Vitest everywhere including NestJS (via `unplugin-swc`).** One runner, one preset, one coverage format. `[D01#23]`
24. **Tailwind v4, CSS-first, no `tailwind.config.ts`**; tokens in `packages/config/tailwind/theme.css` with `@source` pointing at sibling packages. `[D01#24]`
25. **`nestjs-zod`: one definition per request/response shape.** `createZodDto()` + `patchNestJsSwagger()` means the published OpenAPI spec cannot drift from what the API accepts. `[D01#25]`
26. **Prisma's `prisma-client` generator pinned to `moduleFormat = "cjs"`, output in `apps/api/src/generated/prisma`**, excluded from lint and the type-aware tsconfig. CJS is what prevents `ERR_REQUIRE_ESM` at boot under `module: Node16`. `[D01#26]`
27. **A single root `.env`, every compose credential interpolated from it, `DATABASE_URL` derived from its parts.** This is what makes "they cannot drift apart" actually true. `[D01#27]`
28. **Only stateful services in Docker; apps run on the host.** Faster restarts, working debuggers, no bind-mount watching problems on Windows. `[D01#28]`
29. **No changesets, no versioning, no `publishConfig`.** Every package is private and consumed via `workspace:*`. `[D01#29]`
30. **Five env rows deleted in favour of code constants** (`S3_REGION`, `S3_FORCE_PATH_STYLE`, `RATE_LIMIT_WINDOW_SEC`, `RATE_LIMIT_MAX`, `TOTP_ISSUER`) plus three `.npmrc` lines. `[D01#30]`

### 3.2 Data model — `[D02]`

31. **The live schema is ten relational tables; JSON appears only in `snapshots.ir`.** C3 — it is what makes per-object permissions, per-object `version`, comments on one column and partial reads possible at all. `[D02#1]`
32. **`project_id` is denormalised all the way down to `index_columns` and `link_endpoints`.** C6 — loading a project is eleven parallel single-index scans with zero joins; purging one is sixteen flat deletes that leave every trigger nothing to find. `[D02#2]`
33. **Engine-specific vocabulary never gets a core column.** FK actions, index predicates, operator classes, enum labels, type parameters live in `engine_props`, validated by the engine's zod schema (C4). `[D02#3]`
34. **`Area` has no `engine_props` and no engine involvement.** It is a canvas/organisation concept core owns, not one of the seven IR object kinds. `[D02#4]`
35. **A foreign key is a `Link` row, not a `Constraint` row.** One user-visible concept, one object, no synchronisation problem; the edge list is a plain scan, not a filtered polymorphic one. **[merged]** `[D02#5 + D04#6]`
36. **`link_endpoints` exists from day one so composite foreign keys work.** Multi-tenant schemas use them constantly; adding the table later means migrating every link. `[D02#6]`
37. **`access_grants` is polymorphic on both sides and pays for it in `0002`.** The resolver's single hot query (`project_id` + `(principal_type, principal_id)`) is worth more than four FKs; lost integrity is bought back by named CHECKs, partial uniques and two trigger functions. `[D02#7]`
38. **Built-in and custom roles share one table.** One resolver code path, one list in the sharing dialog; built-ins are `organization_id IS NULL` guarded by `roles_builtin_global_ck`. `[D02#8]`
39. **A share link is a principal and its session is stateless.** `share_links` holds token + policy; scope and role live in an ordinary `access_grant` whose principal is the link. The visitor carries a signed `sl_session` cookie — no `sessions` row, because `sessions.user_id` is NOT NULL. Revocation sets `revoked_at` **and** deletes the grant. `[D02#9]`
40. **`position` is never unique.** Reorders renumber siblings in one transaction; partial unique indexes cannot be deferred in PostgreSQL, so uniqueness buys a constraint violation, not an ordering guarantee. `ORDER BY position, id`. `[D02#10]`
41. **Users are hard-deleted; their work is `SetNull` and their name is denormalised into the logs.** C8 gives tombstones only to projects and orgs; GDPR erasure wants a real delete. `[D02#11]`
42. **Nothing can erase the audit trail by cascade.** `audit_log.project_id` and `.organization_id` are both `SetNull` with `organization_name` denormalised alongside `actor_email`. Erasure becomes a reviewable retention job. `[D02#12]`
43. **Three trigger functions, none of them generic.** `purge_polymorphic_refs`, `purge_empty_index`, `purge_empty_keyed_constraint` plus the one-line `purge_share_link_grants`. The earlier generic `purge_empty_owner` built SQL at runtime on every child delete; same line count, no dynamic SQL. The link-purge trigger is gone entirely — a zero-endpoint link is a legal entity-level link. `[D02#13]`
44. **Five FKs are `NO ACTION DEFERRABLE INITIALLY DEFERRED`, not `RESTRICT`** (`projects.workspace_id`, `entities.namespace_id`, `custom_types.namespace_id`, `fields.custom_type_id`, `access_grants.role_id`). `RESTRICT` under a cascading parent fires mid-cascade and made org delete and project purge fail order-dependently. `[D02#14]`
45. **`mentioned_ids text[]` instead of a `comment_mentions` table.** The value is only ever read whole. `[D02#15]`
46. **Permission atoms and notification kinds are `String`, not PostgreSQL enums.** `ALTER TYPE … ADD VALUE` cannot be used in the transaction that added the value, so a migration adding an atom and seeding it fails and must split across two deploys. The zod union in `contracts` is now the only source. `[D02#16]`
47. **`SchemaIndex` / `SchemaIndexColumn` are the only Prisma names that are not the singular of the table name.** `prisma.index` is a landmine in a product about database indexes. `[D02#17]`
48. **The whole permission model ships in `0001`** even though Phase 1 writes one grant per project. Migrating a live permission model is the pain this pass exists to avoid. `[D02#18]`
49. **Permission-cache invalidation is three `perm_generation` columns in PostgreSQL (org / project / user), read on every resolve; the Redis mirror is deleted.** Committed with the change they describe, so a crash or eviction cannot leave a stale entry valid forever, and a Redis flush narrows access rather than widening it. Three scopes remove the fan-out problem; the mirror's write-back raced every revoke and resurrected revoked grants for up to 10 s. **[merged]** `[D02#19 + D05#15]`
50. **Offboarding is enforced by liveness, not cleanup.** A `user` grant counts only while that user is an `OrgMember` of the grant's org — a lookup the resolver already performs. The delete in the same transaction is hygiene. `[D02#20]`
51. **Canvas geometry is outside C7, and ordered child rows are versioned by their parent.** Auto-layout on 300 entities must not 409 every open property panel; a composite key's column order must not be last-write-wins. `[D02#21]`
52. **Uniqueness has exactly one canonical representation.** Table-level UNIQUE is always a `Constraint` with `kind='unique'`; `indexes.is_unique` is only for a bare partial/expression unique index. Two self-consistent conventions would both pass the round-trip test and break the `one_to_one` exporter check forever. `[D02#22]`
53. **One `refs Json` column per `engine_props`-bearing table, written by the engine's required `extractReferences(object, subKind, model)`, is the mechanism for redacting expressions core is forbidden to parse.** Rejected the three narrower `*_referenced_ids` arrays: they missed `CREATE INDEX ON employees ((salary * 12))`, which names no field id at all. Fails closed — an engine returning `[]` gets every expression-bearing prop dropped for subjects lacking `field:viewRestricted` — and doubles as the rename/delete staleness detector. **[merged]** `[D02#23 + D03#23 + D05#12]`
54. **Engine *plugin* version is a column separate from `engine_version`.** `engine_version` is the target database ("16"); `engine_plugin_version` is the contract version the stored `engine_props` were written under, on `projects` **and** `snapshots`, so a cross-major restore is refused rather than writing rows no later edit can save. `[D02#24]`
55. **`fields.depth` is deleted** along with its two CHECKs. It was a derived value the application had to maintain, the single point of failure for the no-cycles argument, and nothing queried it. Ceiling and cycle check both come from the one recursive CTE `reparentField` already runs, now `UNION` so it terminates on a malformed tree. `[D02#25]`

### 3.3 Engine seam — `[D03]`

56. **`EngineDefinition` splits into `EngineStaticFacet` (isomorphic) and the full server-side definition, with `propsSchemas` on the static half.** The PostgreSQL parser is megabytes of WASM; the browser needs capabilities, types, nouns and the zod schemas its forms validate against. The browser reaches the facet through `createEngineFacetRegistry()` keyed on `project.engineId`; the **imported facet, not the `GET /engines` payload, is authoritative on the client**. `[D03#1]`
57. **Capabilities are pure JSON, a total boolean record defaulting to `false`, and an atom exists only when no descriptor already answers the question.** Totality means core never branches on `undefined`; deny-by-default means a new SDK feature never auto-enables for an untested engine. Cut from 33 atoms to 10, with 12 derived helpers; `defineCapabilities` enforces fifteen written invariants and throws `CapabilitiesContradictionError`. `[D03#2]`
58. **Link legality is declarative data evaluated by one shared `checkLink`.** The canvas needs a synchronous answer mid-drag and the server needs the same answer on write; a method on the definition forces either a round-trip per drag frame or two copies of the rules. `[D03#3]`
59. **Terminology lives on the client facet, not the UI plugin** — a deliberate deviation from the brief. Nouns are strings, not React, so an engine with no UI package still says "Add collection". `[D03#4]`
60. **Core owns the message catalog; engines own only nouns.** Engines cannot drift the product's voice, translation has one catalog, and an AST-based grep test fails the build the moment someone types a literal "Add table". `[D03#5]`
61. **`engineProps` schemas are `.strict()` and resolved per sub-kind.** Junk in JSONB is unrecoverable later, and tables and views genuinely have different props. Stripping unknown keys was rejected: it destroys data on the way back up after a rollback. `[D03#6]`
62. **Props validation blocks a write; validator errors do not.** A props failure is a structurally wrong row; a validator error is a design that is temporarily invalid, which is normal halfway through an edit. `[D03#7]`
63. **Importer and migration generator must account for every input.** Statement-level reports with a mandatory reason for anything not applied, and an `unsupported` list on the migration plan. Silent dropping is what destroys trust in an import tool. `[D03#8]`
64. **The exporter has a written total ordering** (phase, dependency, byte-order tie-break) tested for determinism and input-order independence, so an export diff is a schema diff. `EXPORT_PHASE_ORDER` lost the `views` phase entirely — views and matviews are already entities, which also fixes the matview-index ordering bug. `[D03#9]`
65. **Quick fixes are a five-case serialisable edit union carrying `targetVersion`, not a patch language.** They travel as JSON, apply through the normal update endpoint, and a stale one 409s cleanly instead of clobbering. `deleteObject` routes to the delete endpoint with its own permission check; the type forbids a project-targeted fix. `[D03#10]`
66. **`restrictedProbe` stays optional and core never supplies one.** The "leaks no more than the canvas" claim was false — the canvas stubs only entities *linked* to something visible, while the probe answered for any name typed. An unresolvable identifier is `unknown`, indistinguishable from a typo. **[merged]** `[D03#11 + D05#24]`
67. **The AI context format is a line-oriented pseudo-DDL (SCS), not JSON**, with one production per line and a written escaping rule. 3–4x fewer tokens, in-distribution, trimmable by deleting lines, deterministic so it is prompt-cacheable. Doc text is untrusted input written by anyone with `docs:edit` and read by a more privileged user, so it is collapsed, escaped and truncated before reaching a quoted slot — a prompt-injection defence, not formatting. `[D03#12]`
68. **Nothing carrying `restricted` reaches the AI, at any level** — the serialiser omits it and everything that would name it, as its own invariant rather than a caller's obligation, asserted by a conformance check. Chosen over a `restrictedFields: omit | nameAndType` option because an option implies the other answer is legal. `[D03#13]`
69. **AI output uses XML-ish tagged blocks and the SDK ships the incremental parser.** A partial JSON string cannot be rendered, a partial query block can — but only if something can consume one, so `createTaggedBlockStream()` is core-owned. `parseOutput(text, mode)` is mode-aware and returns a union; `draft-schema` returns source + importFormat routed back through `importer.import`, so there is one path from text to schema. `[D03#14]`
70. **`suggestJoinPaths` is optional with a shared BFS default.** No engine should write a second graph search. `[D03#15]`
71. **Engine version drift produces read-only verdicts and nothing else — no migration machinery — and semver is compared in full, not by major.** The upgrade-on-open transaction was a project-wide write on a read path with no lock, no actor and a rollback that discarded its own failure flag. Full comparison closes the `.strict()` rollback incident (1.5 adds an optional key, users set it, ops rolls back to 1.4, every write 422s unfixably), which is the drift that will actually happen. Snapshots carry their own `enginePluginVersion`; a cross-major restore or diff is refused. `[D03#17]`
72. **A missing or broken UI plugin degrades to `FALLBACK_ENGINE_UI` rather than failing.** Since nouns, capabilities, types and props schemas come from the client facet, a backend-only engine is genuinely usable — which is what makes the "no core changes" claim true in practice. `[D03#18]`
73. **A type label is rendered on demand, never stored.** `TypeRef` carries `name` / `args` / `dimensions` / `customTypeId` and nothing else. A value both client and server compute is a value that drifts (`varchar(255)` vs `character varying(255)`), after which search and docs mode disagree about identical types. Side effect: `assembleModel` is engine-free, and `TypePickerProps` traffics in `TypeRef`, not strings. **[merged]** `[D03#19 + D04#5]`
74. **`annotateDiff` returns a branded `AnnotatedDiff` that the migration generator requires.** A comment saying "already annotated" is not a guardrail on a path whose failure mode is an uncommented `DROP COLUMN` against production. The brand carries an `entryRisk` side map so a `removed` entry can be destructive at all — doc 04's `PropertyChange` array exists only on `changed` entries. `[D03#20]`
75. **The exporter takes no doc map, and a redacted export is announced rather than faked.** A masked field is **skipped** in DDL, not emitted by name and type, because doc 04 blanks the `engineProps` holding its default and `salary numeric NOT NULL` without `DEFAULT 0` is a script that corrupts or fails. One un-quantified header notice plus `ExportResult.incomplete` — a *count* of what you cannot see is itself the leak. `[D03#21]`
76. **Diagnostics carry `code` + `params`, never prose, and are rendered per recipient after redaction.** The validator runs on the unredacted model and its output is cached per project and broadcast to every socket; a pre-rendered sentence cannot be filtered. `renderDiagnostic` is core's only renderer and its `resolveRef` callback is the redaction boundary, substituting "a restricted object". `[D03#22]`
77. **Whole-model validation runs in the existing BullMQ worker; only scoped write validation is inline.** 300+ entities is 10–20k IR objects, not "hundreds of rows", and a synchronous pass from the project-health meter stalls every other request on a single-threaded instance. `ValidationTrigger` deleted — nothing branched on it. `[D03#24]`
78. **The validator is server-side-only over the *unredacted* model, with diagnostics filtered afterwards.** Forced: doc 04's redaction deliberately produces ordinal gaps and dropped index/constraint references that the validator lists as errors. `[D03 §8.3]`
79. **`MigrationStep` carries `covers: readonly IrObjectRef[]` (non-empty) plus `operation`, with its own `MIGRATION_PHASE_ORDER` rather than borrowing `ExportPhase`.** The guarantee becomes "covered by at least one step or listed in `unsupported`, never both", which a correct generator can actually satisfy. `[D03#8a]`

### 3.4 IR & diff — `[D04]`

80. **Normalized maps keyed by id, no nesting in the stored shape.** Diff, canvas memoization, row assembly and realtime patching all become O(1) lookups; the only thing lost — child ordering — was already an explicit `ordinal` under C11. `[D04#1]`
81. **Collections keyed by the singular type name (`objects.entity`).** Every generic routine is written once over `IrObjectType` with no irregular-plural mapping table and no casts. `[D04#2]`
82. **"Core iff engineless code reads it."** A decidable rule for the core vs `engineProps` split, with the consumers of "engineless code" enumerated so a reviewer can apply the rule instead of arguing. Core properties are explicitly *not* assumed equal to the relational columns. `[D04#3]`
83. **`engineProps` may never reference another IR object.** Otherwise core cannot validate, cascade or redact it — which is why `IndexColumn.role`, `TypeRef.customTypeId` and `LinkEndpoint.fieldIds` are core structures, and why `index_columns` needs an `is_include` column rather than an engineProps array of field ids. `[D04#4]`
84. **Kinds are plain `string` in core; engines narrow them with type guards.** `OpenKind` and its five aliases are deleted — `z.infer` produced plain `string` anyway, so they never appeared in a single IR type. `[D04#7]`
85. **Field nesting is flat with `parentFieldId`, and nothing else nesting-related ships in Phase 1.** `parentFieldId`, the cycle check, the entity-ownership check and `MAX_FIELD_DEPTH` stay; `FieldNode`, `fieldTree` and the name-path escaping apparatus are deferred to the first engine that sets `supportsNestedFields: true`. `[D04#8]`
86. **Ids address fields; name paths render them.** `address.geo.lat` is a display string, `[id, id, id]` is the identity, so comments, grants and diffs survive renames. `[D04#9]`
87. **zod first, types inferred, all eight object schemas written out in full.** One definition per type, `FooSchema` / `Foo` naming, parsing at trust boundaries only. The two shapes zod cannot express (`SchemaOperation`, `SchemaDiff`) are named as explicit exceptions. `[D04#10]`
88. **Logical keys are total and injective per object type**, including for column-less constraints, column-less links and redacted stubs (`@<name>` then `#<id>`; `<tag>:#<id>` for restricted). `DUPLICATE_LOGICAL_KEY` is demoted to a warning — two table-level CHECKs on one table were breaking the flagship DDL-import workflow. `[D04#11]`
89. **Exactly one id type, `Id`.** The ten per-object aliases were all `= string`, so TypeScript accepted any of them anywhere. `[D04#12]`
90. **One `SchemaDiff` serves the visual diff and the migration generator**, with selectors (`entriesByEntity`, `entriesOfType`, `destructiveEntries`) instead of a second type. `[D04#13]`
91. **The diff is one flat, `sortPath`-sorted array discriminated by `objectType`**, with every `sortPath` segment defined, percent-encoded and shown in a worked example per object type. `[D04#14]`
92. **Matching is id → logical key → human-pinned pairs. There is no rename heuristic.** The old weights could not detect an entity rename at all (max 0.50 against a 0.6 threshold), could score 1.20 on a 0..1 scale, and keyed their top weight on the deleted `type.display`. An applied rename is now exactly one `changed` entry with a `name` `PropertyChange`, so a rename that also changed the type no longer loses the type change. `[D04#15]`
93. **Four severities, and `governance` is the new one.** `isRestricted`, `isPii` and `areaId` emit no DDL but change who can see an object; they must never be dropped by `ignoreCosmetic`, which is what the history UI's default filter and the migration generator both pass. `[D04#16]`
94. **Core never decides what is destructive** — except that removing a namespace, entity, field or custom type always is. `[D04#17]`
95. **Rows are the truth; a typed `SchemaOperation` batch is the only write path; the IR is the read model.** One transaction per user gesture, one place for permission and version checks, and the batch result doubles as the realtime frame and the input to the client's optimistic merge. `[D04#18]`
96. **`version`, `restricted`, `refs` and `doc` are server-owned; `ordinal` is server-assigned on create.** A patchable derived `doc` would let a client forge search results and AI context; a client-minted `ordinal` let two simultaneous column adds both write 7, with no database constraint to catch it. `ORDINAL_COLLISION` now checks density (0..n-1), not just uniqueness. `[D04#19]`
97. **Permission requirements are an explicit op x patched-keys table returning a set** (`requirementsOf(op, live)`), including `sharing:manage` to clear `isRestricted`, `schema:edit` + `field:viewRestricted` to set it, `schema:edit` on **both** endpoint entities of a link, and old+new area on an `areaId` change. The `docs:edit` branch is deleted by making `doc` server-owned. `[D04#20]`
98. **Visibility is checked before versions, and `VersionConflict.current` is redacted.** Otherwise a deliberately-wrong `expectedVersion` is a read primitive for any object whose entity the actor may edit but whose contents they may not see. `[D04#21]`
99. **Cascades report modifications as well as removals, and cascade-modified objects skip `expectedVersion`.** Without it, an index, constraint or link touched by someone else's field delete desyncs every other client permanently. An emptied link endpoint degrades the link to entity-level; it does not delete it. Cascade extends to areas, docs, comments and access_grants — deleting grants with their object closes the id-reuse re-grant hole by construction. `[D04#22]`
100. **`batchId` is a correlation id, not an idempotency key; timeouts are resolved by refetching, never blind retry.** There is nowhere to record applied batches, and claiming an unimplementable guarantee is worse than either honest alternative. `[D04#23]`
101. **Restore is server-side, unredacted, project-scoped; `opsFromDiff(diff, live)` throws on a redacted input and takes `expectedVersion` from the live model.** On the actor's redacted model it would have emitted deletes for every object outside their grant, atomically and irreversibly; on the snapshot's frozen versions it would have 409'd every op and never worked at all. `[D04#24]`
102. **The redacted IR *is* a `SchemaModel`** — removals, blanking to constants and dense ordinal renumbering, with **real ids throughout** — so the canvas, the diff and the exporter run unchanged on it. Doc 05 owns the rules; doc 04 owns the shape and owes a `validateModel`-clean result, asserted by the conformance suite. `[D04#25]`
103. **Redaction blanks to CONSTANTS rather than removing keys**, which is what makes a redacted model parseable by the same zod schemas. Required relaxing `TypeRef.name` and every `kind` from `.min(1)` to plain string; the engine validator rejects empties on a live model. Stub entities carry the project's default namespace id so nothing dangles. `[D04#2a]`
104. **Link redaction preserves arity and pairing.** Mask mode rewrites endpoint field ids to the masked fields' stub ids; hide mode clears BOTH sides' `fieldIds` together and marks the link restricted. One-sided truncation was both a `LINK_ARITY` error and a silent re-pairing of composite FK columns. `[D04#3a]`
105. **Realtime filtering is a visibility *transition*, not a filter**, plus an `access-changed {projectId, generation}` event for grant changes. visible→masked emits the redacted post-image, visible→hidden emits a synthetic `removed`, hidden→visible emits the full post-image, and `removed` is never filtered. Dropping a newly-invisible object from the frame leaves the old, unredacted copy in the recipient's memory for the whole session. `SchemaOperationResult` gains `projectId`, `actorUserId` and a per-project monotonic `seq`. `[D04#26]`
106. **Structural validation here, catalogue and syntax validation in the engine — but identifier folding is injected into core via `normalizeName`.** Without it the core import matcher inserts a duplicate `Orders` next to `orders` and the export emits DDL PostgreSQL rejects. It is injected on the index, not on the JSON-safe model. `[D04#27]`
107. **The engine validator never blocks a write; export and migration generation are gated on it.** You can save a half-typed type name; you cannot emit DDL from one. `[D04#28]`
108. **One index, memoized on a `WeakMap` keyed by the model object, with all fourteen internal maps declared on the interface** plus two mutable memo slots. Immutable model replacement makes cache invalidation free, and a full rebuild at this scale is cheaper than incremental bookkeeping. `[D04#29]`
109. **Eleven `*Row` structural types and a real per-type row→IR mapping table** replace the false "1:1, assembly is keyBy" claim, resolving all nine doc 02 divergences explicitly (3 need new doc 02 columns, 2 resolved in doc 02's favour, 4 resolved by deleting IR properties). `[D04#14a]`
110. **`DocRef` is capped at a 200-char `excerpt` and `FieldDocFacts` is dropped from the IR**, giving a revised size budget of ~2.3 MB worst case with docs, ~250 KB gzipped. `[D04#18a]`

### 3.5 Permissions & redaction — `[D05]`

111. **Nine atoms, closure applied at write time (R1).** Resolution is then pure set algebra with no rule evaluation, which is what makes the whole matrix snapshot-testable without a database. `[D05#1]`
112. **Built-in roles form a strict chain: viewer ⊂ commenter ⊂ documenter ⊂ editor ⊂ manager (R2).** A totally ordered ladder is explainable in one sentence and makes "a more specific grant overrides" a well-defined strengthening or weakening. `[D05#2]`
113. **`ai:use` is an additive-only grant modifier (R7), with `canViewRestricted` as its symmetric twin (R8).** The boolean can only add, never remove, so the spec's two representations cannot contradict each other. `[D05#3]`
114. **No deny grants (R14); per-principal nearest-level-wins, then union across principals (R15 + R16).** Monotone in principals, so group unions are safe and caching is sound. The resulting footgun — a narrowing grant defeated by a group — is surfaced as an API warning computed by `resolveResource`, not hidden. Worked examples: project Editor + area Viewer is read-only; three equally-specific grants union to the most permissive; narrowing one path does not narrow the others. `[D05#4]`
115. **R5 is implemented by unioning `sharing:manage` downward inside the resolver's per-principal cascade (step 4b), not by a guard special case.** `atomsAt(map, skel, ref).has(atom)` *is* the ancestor-OR; R4 reads the right grantor set for free; property test P12 asserts the union never introduces `schema:view` where the chain had none. `[D05#5]`
116. **Attenuation is measured at the resource exactly (R4), and grant deletion is exempt (R4a).** Delete-then-regrant is the single stated escape hatch from a self-narrowing grant, and the 403 body carries `remedy: 'delete_narrowing_grant'`. Chosen over unioning all ancestor atoms into the grantor set because it is strictly safer and needs no new machinery. `[D05#6]`
117. **Org owner/admin is an unconditional short-circuit (R13), and the skeleton is loaded *before* it.** Loading it after gave every org owner an empty visible set and made `VisibilityFilter` redact the whole schema away from the people holding all nine atoms. `[D05#7]`
118. **Share links are an ordinary `AccessGrant` with a code-level ceiling of `{schema:view}` and an allow-list of reachable routes (R17, R21).** Creation always writes the built-in `viewer`; the link is the single source of its own target (R25), so `ShareLink` carries no `resourceType`/`resourceId`/`organizationId`; revocation deletes both rows in one transaction, closing "unlocked successfully, then 404 on everything". Cookie is `Path=/`, scoped by `session.pid`. `[D05#8]`
119. **The allow-list replaced a deny-list (R21 inverted).** `schema:view` is deliberately fat, so every future surface built on it was a share-link leak by default; the boot sweep now asserts every route is classified. `[D05#9]`
120. **Ids in a redacted model are real; confidentiality lives in the blanked properties.** The HMAC stub-token scheme, `stubKey`, HKDF and the `*st_` DTO ban are all deleted: they bought nothing a cuid does not already give (no name, no cross-project correlation, 404 on every route), broke "Request access" and field reorder, and required a key-derivation path and a rotation story nobody had. `[D05#10]`
121. **A masked field discloses no name and no type (§7.10, §8.5).** SchemaLoom stores no data, so names and types *are* the content; a mask that keeps them makes `field:viewRestricted` decorative and leaves the spec's own workflow-#2 freelancer reading `salary numeric(10,2)`. This is the one substantive disagreement with doc 04, and it is argued, not asserted. `[D05#11]`
122. **Restriction is inherited down the field subtree (R24), and hide-mode renumbering is per `(entityId, parentFieldId)` sibling group (L22).** Entity-wide renumbering would have corrupted every nested field. `[D05#13]`
123. **Restore never writes `isRestricted` or `areaId` (R28);** both are preserved from live rows with fail-closed defaults for rows that no longer exist. Otherwise a `schema:edit`-gated feature silently un-restricts a column that R20 says needs `sharing:manage`. `[D05#14]`
124. **`validUntil` folds in `share_links.expires_at`, and the Redis TTL is derived from it.** An expiring link can no longer leave a 300-second map alive behind it; a cached map is capped at `min(TTL, nearest expiry)`. `[D05#16]`
125. **The permission map stores `entityOverrides`, not a full `entityAtoms` map.** Same semantics, ~2 KB instead of ~50 KB per subject per project, and one cached shape rather than four derived fields that can drift; `visibleEntityIds` / `restrictedOkEntityIds` become pure functions over map+skeleton. `ProjectSkeleton.fieldsByEntity` is deleted outright — nothing read it. `[D05#17]`
126. **A group's grant change bumps the project, not the org, and a bulk operation bumps exactly once (R29).** The most frequent sharing operation no longer cold-starts every cache in a 200-user org, and a 300-table import produces one invalidation, not 300. `[D05#18]`
127. **Every access-control write takes a project advisory lock, re-resolves inside it, and commits the change, audit row and generation bump together (R26)** — and access-control rows carry no `version Int`, a deliberate, stated C7 deviation, because the lock guards *sequences* and a per-row version cannot. `[D05#19]`
128. **`resolveResource` is a named algorithm, not a hand-wave (R23).** Three shipped features and two more need the inverse direction; two queries serve all of them, and P13 asserts the two directions agree. `[D05#20]`
129. **R19 covers update and delete, not just create.** Area delete/update is authorised at the PROJECT (so the Billing-only editor cannot delete the boundary she lives inside and lock herself out); link create/update/delete requires BOTH endpoints (so she cannot drop an FK on a Catalog table she cannot see). The UI hides destructive affordances on stub-touching links and the API returns 403, not 404. `[D05#21]`
130. **Entity deletion hard-deletes that entity's grants, with a before-image, in the same transaction, plus a weekly sweep.** Orphaned grants were making `GET /projects` resolve dead projects on every page load. `[D05#22]`
131. **Saved queries and AI transcripts are filtered by persisted `touchedEntityIds`/`touchedFieldIds` and omitted WHOLE when they fail (L25).** Their body *is* the payload; SQL cannot be partially redacted, and a thread with holes replays nonsense to the provider, so a thread with any failing message 404s entirely. `[D05#23]`
132. **The raw model is unreachable, not merely discouraged (§8.6).** `redact` moves into `packages/schema-model` beside a hash-private `RawSchemaModel` with a throwing `toJSON` and a module-private unwrap, so `return raw.ir` no longer compiles — true encapsulation with no lint rule. The interceptor additionally rejects any `SchemaModel`-shaped value whose `redacted !== true`, and the socket and export paths call `assertRedacted` explicitly because Nest interceptors do not cover them. `[D05#25]`
133. **404 for invisible, 403 for visible-but-forbidden, with byte-identical 404 bodies (§10.3),** asserted by a property test — this is the difference between a permission system and an existence oracle. `[D05#26]`
134. **`restrictedFieldMode` defaults to `mask`, as a real enum column on `Project` (§6.3).** `hide` has an irreducible name-collision oracle (L21) and produces a schema the user can act on wrongly. A real column also takes a zod parse off the security hot path. `[D05#27]`
135. **R21′ covers import, restore and migration generation — and not autolayout.** Laying out boxes cannot drop a table you cannot see; including it only gave the spec's own freelancer a 403 that reads as a bug. `[D05#28]`
136. **No write endpoint accepts a full-list replacement of a redactable collection (R22 / L20),** and `beforeFieldId` may name a masked field, because otherwise a redacted client cannot reach the end of its own field list. `[D05#29]`
137. **The permission matrix is a generated, committed CSV snapshot (§11.1)** — 1,056 assertions per mode reviewed as a diff, not 25,920 hand-written cases nobody reads. Backed by hand-written cases, fast-check property invariants, integration and e2e. `[D05#30]`
138. **Snapshots: read and diff require `history:view` at PROJECT scope; restore additionally requires `schema:edit` at project scope.** The IR blob is opaque so `VisibilityFilter` cannot filter it; an area-scoped Editor would otherwise read every hidden entity. Restore takes a project row lock and returns 409 with code `project_restored` so clients reload rather than retry. `[D02#7a + D05]`

**Merges applied:** #14 (`D01#14` + `D03#16`, engine status field), #35 (`D02#5` + `D04#6`, FK is a Link), #49 (`D02#19` + `D05#15`, generation counters), #53 (`D02#23` + `D03#23` + `D05#12`, `refs` / `extractReferences`), #66 (`D03#11` + `D05#24`, `restrictedProbe`), #73 (`D03#19` + `D04#5`, no `TypeRef.display`). Nothing else was dropped.

---

## 4. Cross-document contract table

Every shared type, model, function or constant, with its owning document and its
consumers. "Owner" means the document that defines the shape; a consumer may not
change it unilaterally.

### 4.1 Owned by `[D01]` — wiring, modules, environment

| Name | Owner | Consumed by | Note |
|---|---|---|---|
| `EnginesModule.forRoot`, `ENGINE_DEFINITION` token, `engines.manifest.ts` | D01 §4.2 | D03 | Only file naming a concrete engine; D03 must not add `status` to `EngineDefinition` |
| `GET /engines` → `{ available: EngineDescriptor[], comingSoon: {id,displayName,paradigm}[] }` | D01 §4.2 | D03 | `comingSoon` is a server-side const |
| Guard chain `JwtAuthGuard` → `PermissionGuard`, five route markers, boot-time route sweep | D01 §4.1 | D05 | D05 owns the decorator semantics; see delta ∆7 |
| `@schemaloom/engine-sdk/ui` re-export list (type-only) | D01 §6.1 | D03 | See delta ∆8 |
| `runEngineConformance(engine, fixtures)` + assertion list | D01 §6.2 | D03 | D03 owns the *check list*; D01 owns the entry point. See ∆9, ∆10 |
| Cookie inventory: `sl_access`, `sl_refresh`, `sl_presence`, `sl_csrf` | D01 §5.4/§11.1 | D02, D05 | `sl_session` missing — see ∆11 |
| `REDIS_CACHE` / `REDIS_RATELIMIT` / `REDIS_QUEUE` tokens, `${REDIS_KEY_PREFIX}cache:` / `rl:` / `q:` prefixes, mandatory TTL | D01 §4.4 | D05 | See ∆12 |
| Export format split: DDL/JSON/Markdown server-side, SVG/PNG client-rendered, PDF Phase 5 | D01 §4.3 | D03 | `apps/api` has no headless browser |
| e2e global setup, `schemaloom_e2e` `_e2e`-suffix assertion, `packages/contracts/src/fixtures.ts` | D01 §12.2 | D02, D05 | D05's permission fixtures build on this |

### 4.2 Owned by `[D02]` — columns, constraints, migrations

| Name | Owner | Consumed by | Note |
|---|---|---|---|
| `permissionAtomSchema` (zod enum of the nine C5 atoms) | D02 → contracts | D05, D03 | Single source of the atom vocabulary; `roles.atoms` is `String[]`, no PG enum |
| `notificationTypeSchema` | D02 → contracts | apps/api | Replaces the `notification_type` PG enum |
| `BUILTIN_ROLE_IDS` (five fixed cuid-shaped ids) | D02 → contracts | D05, migration 0003, seed, fixtures | Resolver's `findUnique` lookup |
| `notificationPrefs` / `orgSettings` / `projectSettings` `{Input,Stored}Schema` pairs | D02 → contracts | apps/api, apps/web | strict for PATCH, strip for read-back |
| `typeArgsSchema` guarding `fields.type_args` | D02 → contracts | D04 | |
| `MAX_FIELD_DEPTH` | D02 + D04 (shared) | D04, apps/api | Only home for the nesting ceiling since `fields.depth` is gone |
| `refs Json` on every `engine_props`-bearing table | D02 §7 | D03, D05 | Written from `extractReferences`; the mechanism for R27 |
| `projects.engine_plugin_version`, `projects.schema_revision`, `snapshots.engine_plugin_version` | D02 | D03 | Added; D03's cross-doc deps 1–3 satisfied |
| `fields.type_args`, `fields.type_dimensions`, `index_columns.is_include` | D02 | D04 | Added; D04's D1/D2 satisfied |
| `Project.restrictedFieldMode` (enum column), `permGeneration` on Org/Project/User, `AccessGrant.canViewRestricted` | D02 §6 | D05 | Added; D05's four-column demand satisfied |
| Geometry endpoint that neither reads nor bumps `version` | D02 §10.4 | D04 §8.11, apps/api | C7 carve-out |
| `link_endpoints` / `index_columns` / `constraint_columns` writes carry the *parent's* expected version | D02 §10.4 | D04, apps/api | |
| Snapshot guard is project-scoped; restore returns 409 `project_restored` | D02 §11 | D05, apps/api | |
| Canonical uniqueness representation (table-level UNIQUE = `Constraint`) | D02 §10.5 | D03 conformance, D04 | Fixture asserts it |
| Five `NO ACTION DEFERRABLE INITIALLY DEFERRED` FKs; `db:verify` asserts `condeferrable` | D02 §8.6 | CI | |

### 4.3 Owned by `[D03]` — the engine seam

| Name | Owner | Consumed by | Note |
|---|---|---|---|
| `EngineDefinition` (incl. required `extractReferences(object, subKind, model): readonly IrObjectRef[]`) | D03 | D01, D02, D05 | Lost `propsMigrations` and `introspector` |
| `EngineStaticFacet` (+ `diagnosticMessages`, `propsSchemas`) | D03 §16.0 | D01, apps/web | Moved off `EngineDefinition` |
| `RedactedModel = SchemaModel & { redacted: true }` | D03 §2.1 (naming), D04 (module) | D04, D05 | Compile-time half of D05's single-path guarantee. See ∆3 |
| `Diagnostic { code, severity, params, target, range?, quickFix? }`, `DiagnosticParam`, `DiagnosticMessages`, `renderDiagnostic(…, resolveRef)` | D03 §2.3–2.5 | apps/api, apps/web, D05 | No `message`; `resolveRef` is the redaction boundary |
| `QuickFix { labelCode, labelParams, targetVersion, edit }`, `QuickFixEdit` (5 arms incl. `deleteObject`) | D03 | apps/web, apps/api | |
| `DiagnosticTarget.type = IrObjectType \| 'project'`; `EnginePropsKind = Exclude<IrObjectType,'area'>` | D03 | D04 | |
| `ENGINE_FEATURES` — 10 atoms | D03 §4 | D01 conformance, apps/web | `nestedFields, notNull, links, referentialActions, indexes, expressionIndexes, includeColumns, comments, migrations, queryValidation` |
| 12 derived capability helpers | D03 §4.1 | apps/web, apps/api | `supportsNamespaces, anyLinkKindEnforced, anyCompositeEndpoint, anyLinkKindHasFields, anyIndexTypeUnique, anyTypeSupportsArray, hasEntityKind, hasConstraintKind, hasCustomTypeKind, anySchemalessEntity, canImport, canExport` |
| `EntityKindDescriptor.shortCode` (`/^[A-Z]{1,2}$/`, unique); `ConstraintKindDescriptor.hasExpression` | D03 §5 | D03 SCS serialiser, apps/web | `term` removed from all four kind descriptors |
| `EngineCapabilities.typeCatalogSupportsArrays` | D03 | apps/web | Derived by `defineCapabilities` |
| `TypeParameterDescriptor` (kind: number\|string\|enum); `ResolvedType.args: Record<string, string\|number>` | D03 §5 | apps/web, D04 | |
| `LinkCheckReason { code, subject?, vars? }`; `LinkCheck.reasons`; redaction short-circuit (§7.1) | D03 §7 | apps/web canvas, apps/api | |
| `ExportResult { statements, separator, incomplete, diagnostics }`; `EXPORT_PHASE_ORDER` (no `views`) | D03 §10 | apps/api export path | |
| `MIGRATION_PHASE_ORDER`; `MigrationStep { operation, covers, reasonCode, reasonParams }` | D03 §11 | apps/api | |
| `AnnotatedDiff = SchemaDiff & { annotatedBy; entryRisk }`; `entryIsDestructive(diff, entry)` | D03 §11.1 | apps/api, D04 | Workaround for D04's `summary.destructive` undercount |
| `AiContextOptions.selectedEntityIds`; `AiProfile.outputInstructions: Record<AiMode,string>`; `parseOutput(text, mode)`; `AiParsedOutput` (3 arms) | D03 §13 | apps/api AI module | |
| `createTaggedBlockStream()` | D03 §13.3 | apps/api SSE, apps/web | Single core-owned incremental parser |
| `createEngineFacetRegistry()`, `EngineProvider`, `useEngine()`, `useTerminology()` | D03 §16.0 | apps/web | Imported facet is authoritative on the client |
| `EngineNodeProps.badges`, `EngineNodeProps.FieldHandle` | D03 §16.1 | engine UI packages | |
| `EngineUiPlugin.panels` (+ constraint, customType); `PropertyPanelSection.available?(caps)` | D03 §16.1 | engine UI packages | |
| `TypePickerProps { value: TypeRef; onChange }` | D03 §16 | apps/web | |
| `TerminologyBundle` (+ `constraintKindTerms`, `customTypeKindTerms`, no `overrides`); `TermSubject`; `CoreMessageId` | D03 §16.2 | apps/web, D03 SDK | |
| `compareEngineVersion(storedPluginVersion, engine)` — four verdicts, full semver | D03 §15 | apps/api project open | `project-older-major` replaces `upgrade` |
| `errors.ts`: `EngineError`, `DuplicateEngineError`, `UnknownEngineError`, `EngineFeatureUnsupportedError`, `CapabilitiesContradictionError` | D03 §14.1 | apps/api | |
| `ImportContext = EngineContext & { newId }`; `EngineDescriptor extends AnnouncedEngine` | D03 §9, §14 | D01, apps/api | |
| `ConformanceCheckId` (15 new checks), `ConformanceFixtures` (+ `redactedModel`, `expressionReferences`) | D03 §17 | D01 §6.2, engine packages | See ∆10 |
| `PROPERTY_SEVERITY_RANK` | D03 | apps/web history UI | Over D04's `PropertySeverity` |

### 4.4 Owned by `[D04]` — the IR

| Name | Owner | Consumed by | Note |
|---|---|---|---|
| `SchemaModel { irVersion, projectId, engineId, engineVersion, redacted, objects }` | D04 §1 | D03, D05, apps/* | Normalized maps keyed by singular type name |
| `IrObjectMap`, `IrObjectType`, `IR_OBJECT_TYPES` | D04 §1.3 | D03, D05, apps/api | Dependency order = op sort order = `sortPath` typeRank |
| `IrBase { id, name, version, engineProps, restricted?: true }` | D04 §2.2 | D03, D05 | `doc` is NOT in the base. `refs` missing — see ∆1 |
| The eight object types (`Area`, `Namespace`, `CustomType`, `Entity`, `Field`, `Constraint`, `Index`, `Link`) | D04 §2 | everything | |
| `TypeRef { name, args?, customTypeId?, dimensions? }` | D04 §2.6 | D03 type catalog, apps/web | No `display` |
| `DocRef { id, excerpt }`, `DOC_EXCERPT_CHARS = 200` | D04 §2.3 | apps/web, AI serialiser | No facts |
| All eight zod schemas + `PointSchema`, `IndexColumnSchema`, `LinkEndpointSchema`, `TypeRefSchema`, `DocRefSchema`, `IrBaseShape`, `EnginePropsSchema`, `IdSchema`, `SchemaModelSchema` | D04 §5 | apps/api boundaries | |
| Eleven `*Row` types + `AssemblyInput` + `assembleModel` | D04 §8.1 | apps/api read path | Engine-free |
| `SchemaOperation` (Create/Update/Delete), `ServerOwned`, `CreatePayload` (omits `ordinal` for fields) | D04 §8.4 | apps/api, apps/web store | |
| `SchemaOperationBatch`, `SchemaOperationResult` (`= IRPatch`) | D04 §8.4 | D05 `redactPatch`, realtime | |
| `VersionConflict { type, id, expectedVersion, actualVersion, current }` | D04 §8.6 | apps/api, apps/web | `current` is redacted |
| `PermissionRequirement`, `requirementsOf(op, live)` | D04 §8.5 | D05 guard, apps/api | |
| `opsFromDiff(diff, live)`, `applyOps`, `mergeResult`, `upgradeModel` | D04 §8.8 | apps/api restore | |
| `SchemaDiff`, `DiffEntry` (3 variants, `matchedBy`), `PropertyChange`, `PropertySeverity`, `DiffOptions`, `diffModels`, `deepDiff` | D04 §7 | D03 `annotateDiff`, apps/web | 4 severities incl. `governance` |
| Selectors `entriesByEntity`, `entriesOfType<T>`, `destructiveEntries`, `isEmptyDiff` | D04 §7 | apps/web, D03 | |
| `ModelIndex` (14 maps), `IndexOptions`, `createIndex`, `indexOf`, ~20 traversal fns | D04 §9 | D03 BFS default, apps/* | |
| `NormalizeName` | D04 §6.3 (type) / D03 (supplier) | D04 index/diff/validate | See ∆6 |
| `validateModel(model, opts?)`, `ValidationIssue`, `ValidateOptions`, 14 check codes | D04 §11.1 | apps/api | |
| `redacted.ts`: branded redacted type, raw payload type, `BLANK` constants | D04 | D05 §8.6 | Naming conflict — see ∆3 |

### 4.5 Owned by `[D05]` — permissions and redaction

| Name | Owner | Consumed by | Note |
|---|---|---|---|
| `PermissionResolver` (`resolveProject`, `resolveResource`, `skeleton`, `atomsAt`, `assertAll`, `assertMayGrant`, `assertMayDeleteGrant`, `invalidate`) | D05 §7.0 | apps/api | |
| `AccessModule` providers/exports: `PermissionResolver`, `VisibilityFilter`, `SchemaLoader`, `PermissionGuard` | D05 §7.0 | D01 module list | |
| `VisibilityFilter` (`computeContext`, `redact`, `redactPatch`, `redactRefs`, `filterQueryRows`, `redactRichText`) | D05 §8.1 | apps/api, D04 | |
| `redact(raw, ctx)`, `RawSchemaModel`, `VisibilityContext` — living in `packages/schema-model` | D05 §8.6 (rule) / D04 (module) | apps/api | See ∆3 |
| `ProjectPermissionMap` + derived `atomsAt` / `inheritedAtoms` / `visibleEntityIds` / `restrictedOkEntityIds` / `canOpenProject` | D05 §7.5 | apps/api | `canOpenProject` is derived, not a tenth atom |
| `ProjectSkeleton { generation, areaIds, entities, entityById, entitiesWithRestrictedFields }` | D05 §7.5 | apps/api | |
| `@RequirePermission`, `@RequirePermissionAll`, `@RequireProjectAccess`, `@RequireOrgRole`, `@Public` | D05 §10.1–10.2 | D01 guard chain, apps/api | Signature conflict — see ∆7 |
| `PERMISSION_ATOMS`, `PermissionAtom`, `AtomSet`, `closeAtoms`, `BUILT_IN_ROLES`, `BUILT_IN_ROLE_ORDER` | D05 → contracts | D02 seed, apps/* | Exactly this list from `contracts` |
| `SHARE_LINK_ROUTES` allow-list (R21) | D05 §7.12 | D01 boot sweep | Asserted complete at boot |
| Cache keys `perm:3:…`, `skel:3:…`, `orgmem:3:…` | D05 §9.1 | D01 RedisModule | See ∆12 |
| Redaction rules (masked/hidden/propsRedacted, dense renumbering, R27 expression rule) | D05 §8.3–8.5 | D04 shape, D03 exporter/AI | |

---

## 5. Cross-document deltas still outstanding

The reconciliation step never ran, so the demands each document makes of its
siblings are recorded but unapplied. This is the punch list for the first
implementation commit. Each item names the document that must change, the exact
change, and who demanded it. Contradictions carry a recommendation.

**Already applied — no action** (verified against the documents' final text, listed so
nobody re-does them): `Project.enginePluginVersion`, `Project.schemaRevision`,
`Snapshot.enginePluginVersion` (D03→D02, deps 1–3); `fields.type_args`,
`fields.type_dimensions`, `index_columns.is_include` (D04→D02, D1/D2);
`Project.restrictedFieldMode` as an enum column, `permGeneration` on
Organization/Project/User, `AccessGrant.canViewRestricted` (D05→D02);
`ExportInput.model: RedactedModel` and `AiProfile.serializeContext(model: RedactedModel)`
(D05→D03); removal of the sentence implying core implements `restrictedProbe` (D05→D03);
`EngineDefinition` has no `status` field (D01→D03); `migrationGenerator`,
`queryValidator` and `aiProfile` remain optional (D01→D03).

### Blocking — the code does not compile or the security control does not exist

**∆1 — `IrBase.refs` is missing from doc 04's type.**
*Change doc 04.* Add `refs?: ObjectRefs` where `ObjectRefs = { entityIds: Id[]; fieldIds: Id[] }`
to `IrBase` (§2.2), populated by the engine for any object whose `engineProps` or
`IndexColumn.expression` textually references another object.
*Demanded by* D05 (Open question 8, "a hard dependency"), D03 (`extractReferences` produces it),
D02 (the `refs Json` column exists to store it).
Doc 04's own Key decision 19 already calls `refs` server-owned, so this is an omission from the
type list, not a disagreement. **Without it, expression redaction (R27, leaks L3–L6) degrades to
a dev-time string scan, which doc 05 explicitly refuses as the mitigation.**

**∆2 — `RestrictionMark` no longer exists, but doc 05 still demands a field on it.**
*Contradiction.* D05 Open question 8 asks for `'propsRedacted'` on `RestrictionMark.level`, and
D05 §14 row (b) writes `restricted: { level: 'masked' }`. D04 **deleted** `RestrictionMark`
(Key decision 17) in favour of `restricted?: true` (Key decision 1) — a change D04 records as
adopting doc 05's own earlier position.
**Recommendation: doc 04's flat shape wins, and doc 05 changes.** Add a second optional flag
`propsRedacted?: true` to `IrBase` rather than reintroducing a wrapper object; it is one
optional key instead of a type, and both documents already agreed the wrapper was over-built.
*Change doc 05* §8.3 / §8.5 / §14(b) to speak of `restricted?: true` + `propsRedacted?: true`.
*Change doc 04* §2.2 to declare the second flag.

**∆3 — The redaction brand has two names.**
*Contradiction.* D04's contract list declares `redacted.ts: RedactedIR (branded), RawSchemaIR`.
D03 §2.1 and D05 §8.6 both use `RedactedModel` and `RawSchemaModel`, and D05's own Open
question 13 says this revision uses doc 04's `SchemaModel` and the name `RedactedModel`.
**Recommendation: `RedactedModel` / `RawSchemaModel` win** (two of three documents, and the type
is a `SchemaModel`, not a separate IR). *Change doc 04* §10 / `redacted.ts` to rename
`RedactedIR → RedactedModel` and `RawSchemaIR → RawSchemaModel`. The module location
(`packages/schema-model`) is already agreed by all three.

**∆4 — Doc 04 §10.1's "Masked field" paragraph still keeps `name`, `type` and `isNullable`.**
*Change doc 04.* A masked field keeps `id`, `entityId`, `parentFieldId` and `ordinal`, and blanks
`name`, `type`, `isNullable`, the governance flags, `doc` and `engineProps`.
*Demanded by* D05 Key decision 11 / Open question 1 / §14 row (f), which calls it "the single
most security-relevant disagreement in the product".
**Recommendation: doc 05 wins, unambiguously.** SchemaLoom stores no data, so names and types
*are* the content; keeping them leaves the spec's own workflow-#2 freelancer reading
`salary numeric(10,2)` and makes `field:viewRestricted` decorative. Doc 04's Key decisions 1 and
25 already say "masked-field blanking", so only the §10.1 prose is stale.

**∆5 — Doc 04 Key decision 1 says "opaque stubId"; Key decision 25 and doc 05 say real ids.**
*Change doc 04.* Strike "opaque stubId" from Key decision 1 and from any §10 prose. Stub
entities carry their **real** `id`, `kind` and `namespaceId`.
*Demanded by* D05 Key decision 10 and §14 row (g), where doc 04's position is adopted in full and
the whole HMAC/HKDF/`stubKey`/`*st_` scheme is deleted. Doc 04's Key decision 25 already agrees;
Key decision 1 is a leftover from the earlier draft. **Nothing to decide, only to correct.**

**∆6 — `normalizeName` has no declared home on the engine contract.**
*Change doc 03.* Declare `normalizeName(s: string): string` on `EngineStaticFacet` (not the
server-only `EngineDefinition`, because the canvas's name-collision check needs it client-side).
*Demanded by* D04 Key decision 16 and its contract list ("the one engine-supplied function core
takes"), which doc 03's contract list acknowledges only in passing under "Engine hooks this
document depends on". **Without it the core import matcher inserts a duplicate `Orders` next to
`orders` and the exporter emits DDL PostgreSQL rejects.**

**∆7 — `@RequirePermission` has two signatures.**
*Contradiction.* D01 §4.1 specifies `@RequirePermission(resourceType, idParam, atom)`;
D05 §10.1 specifies `@RequirePermission(atom, locator)` plus
`@RequirePermissionAll(atom, locators[])`.
**Recommendation: doc 05's `(atom, locator)` wins.** It is the document that owns resolution
semantics, the locator form is what makes `@RequirePermissionAll` expressible, and doc 01's
positional `(resourceType, idParam)` cannot express a link's two endpoints — which D05 Key
decision 21 requires. *Change doc 01* §4.1, keeping its boot-time route-table assertion unchanged.

### Important — a stated guarantee is not delivered

**∆8 — Doc 01's `/ui` re-export ban excludes `props.ts`; doc 03 moved `propsSchemas` there.**
*Contradiction.* D01 §6.1 lists exactly what `@schemaloom/engine-sdk/ui` may re-export and
explicitly excludes `props.ts`. D03 Key decision 1 / 18 moved `propsSchemas` onto
`EngineStaticFacet` precisely so react-hook-form + zod validation works client-side.
**Recommendation: doc 03 wins.** *Change doc 01* §6.1 to add the `props.ts` *type* surface
(`EnginePropsSchemas`, `EnginePropsResolver`) to the allowed type-only re-exports and drop
`props.ts` from the exclusion list. `verbatimModuleSyntax` keeps them erased, so the bundle split
is unaffected — which is doc 01's own stated reason for the rule.

**∆9 — The conformance entry point has two names.**
*Change doc 01* (internal inconsistency). Key decision 15 says `describeEngineConformance(engine, fixtures)`;
the contract list says `runEngineConformance(engine, { fixtures })`.
**Recommendation: `runEngineConformance(engine, fixtures)`** — positional, matching the arity in
Key decision 15, and "run" reads correctly for something doc 03's check list drives.

**∆10 — Doc 01's conformance assertion list is stale in two ways.**
*Change doc 01* §6.2. (a) Assertion 5 requires `capabilities.supportsX === (engine.x !== undefined)`
for `migrationGenerator`, `queryValidator`, `aiProfile` **and `introspector`** — but doc 03 Key
decision (§12 judgement calls) **deleted the introspector and `features.introspection` entirely**.
Drop `introspector`. (b) Doc 01 says "six named assertions"; doc 03 §17 adds fifteen more
`ConformanceCheckId`s (`links/*`, `references/superset`, `terminology/covers-all-kinds`,
`export/skips-restricted`, `export/redaction-is-announced`, `ai/serialize-omits-restricted`,
`ai/serialize-escapes-docs`, `migration/steps-ordered`, `props/rollback-is-read-only`,
`validator/expression-reference-stale`). Doc 01 Key decision 15 already concedes doc 03 owns the
check list, so doc 01 should stop counting them.

**∆11 — `sl_session` is missing from doc 01's cookie inventory.**
*Change doc 01* §5.4 / §11.1. Add `sl_session`: the signed, stateless share-link visitor cookie,
`Path=/`, scoped by `session.pid`, no `sessions` row.
*Demanded by* D02 Key decision 9 (which deleted `sessions.share_link_id` because
`sessions.user_id` is NOT NULL) and D05 Key decision 8. Doc 01's inventory is declared complete,
so the omission makes it wrong.

**∆12 — Doc 05's cache keys ignore doc 01's Redis key contract, and the TTL rule changed.**
*Change doc 05* §9.1: prefix the three key shapes with `${REDIS_KEY_PREFIX}cache:`, i.e.
`${REDIS_KEY_PREFIX}cache:perm:3:{projectId}:{subjectKey}:{og}.{pg}.{sg}` and likewise for
`skel:` and `orgmem:`. *Demanded by* D01 §4.4, which makes the prefix mandatory on all three
clients as the test-isolation backstop.
*Change doc 01* §4.4 in the other direction: "permission entries EX 300" becomes
`min(300s, validUntil)`, per D05 Key decision 16, and doc 01's description of a Redis generation
mirror (if any survives) must go, per D05 Key decision 15 / D02 Key decision 19.

**∆13 — Doc 03 still asks doc 02 for three `*_referenced_ids` arrays that doc 02 refused.**
*Change doc 03* §3.1 and cross-document dependency 4. Doc 02 Key decision 23 rejected
`constraints.referenced_field_ids`, `index_columns.referenced_field_ids` and
`fields.default_referenced_ids` in favour of **one `refs Json` column per `engine_props`-bearing
table**, because the narrow arrays missed `CREATE INDEX ON employees ((salary * 12))`, which names
no field id at all. Doc 05 Key decision 12 independently chose the same single-field design.
**Doc 02 and doc 05 agree; doc 03's ask is superseded.** Rewrite it to name `refs`.

**∆14 — Doc 05's leak table has no row for the diagnostics channel.**
*Change doc 05* §8.4. Add a leak row covering the engine diagnostics stream (cached per project,
broadcast to every socket), naming doc 03 §2.4's structured `code` + `params` form plus
per-recipient `renderDiagnostic`/`resolveRef` as the control.
*Demanded by* D03 cross-document dependency 6: doc 03 invented the channel and doc 05's audit
never covered it, so the control currently has no documented owner.

**∆15 — Ordinal gaps: doc 04's §10.1 prose has not caught up.**
*Change doc 04* §10.1 (and doc 03's Open question 4 and doc 05's §14 row (a), both now stale).
Redaction **densely renumbers** ordinals within each `(entityId, parentFieldId)` sibling group.
*Demanded by* D05 L22 / P9; doc 04's Key decisions 1, 13 and 25 have already adopted it, so only
the §10.1 sentence "ordinal gaps are normal in a redacted model" remains.
**Recommendation: doc 05 wins — a gap *is* the leak.** The validator tolerating gaps is a separate
concern and is already moot, because doc 03 §8.3 keeps the validator off redacted models entirely.

**∆16 — `access_grants.organizationId`: doc 02 added it, doc 05 dropped it.**
*Contradiction.* D02 adopted `AccessGrant.organizationId` (and uses it in the offboarding liveness
rule, Key decision 20: "a `user` grant counts only while that user is an `OrgMember` of the
**grant's** `organizationId`"). D05 §14 row (i) says it dropped the column because "the project
already carries the org".
**Recommendation: doc 02 wins.** The column is a denormalisation on the resolver's hottest query,
it is what makes the liveness check a lookup rather than a join through project → workspace → org,
and doc 02 owns columns. *Change doc 05* §6.1 to show `organizationId` as present and derived at
write time, and to stop listing its removal as settled.

**∆17 — The access-control column names are reconciled against two different vintages of doc 02.**
*Contradiction, and the messiest item here.* Doc 02's final revision **renamed**:
`GrantResourceType → ResourceType`, `AccessGrant.grantedById → createdById` (plus `note`),
`AccessRequestStatus.cancelled → withdrawn`, `Role.permissions → atoms String[]` (plus
`isArchived`). Doc 05 §14 row (i) declares it "adopted doc 02's names wholesale" and then lists
the **pre-rename** names (`grantedById`, `permissions`/`isBuiltIn`, `cancelled`) as the winners.
**Recommendation: doc 02's final names win** — it owns columns, `Role.atoms String[]` is
load-bearing for Key decision 46 (atoms are `String`, not a PG enum, with
`permissionAtomSchema` in `contracts` as the only source), and doc 05's `PERMISSION_ATOMS` export
already assumes it. *Change doc 05* §6 and §14(i) to use `ResourceType`, `createdById`, `note`,
`withdrawn`, `Role.atoms`, `Role.isArchived`. **Verify this against doc 02's §1 schema before
writing migration `0001` — it is the one delta where reading the source beats reading this file.**

### Minor — tidy before the migration is written

**∆18 — `areas.collapsed` should be dropped.**
*Change doc 02.* D04's delta D3 asked for both `areas.description` and `areas.collapsed` to go;
doc 02 deleted `areas.description` only. `collapsed` is per-viewer client state and is not in the
IR. *Demanded by* D04 Open question 1 and Key decision 14.

**∆19 — Doc 02 §7 contains a stale call sketch.**
*Change doc 02* §7. `engine.propsSchemas.field.parse(...)` no longer typechecks:
`propsSchemas.field` is an `EnginePropsResolver` taking a sub-kind, not a schema.
*Demanded by* D03 cross-document dependency 7.

**∆20 — `summary.destructive` undercount: record the resolution, do not re-open it.**
*No change.* D03 dependency 5 offered doc 04 the choice of adding `destructive?: boolean` to
`DiffEntryBase`; D04's Open question 12 **closed it in doc 03's favour** — the risk lives on
`AnnotatedDiff.entryRisk` and `DiffEntryBase` is untouched. **Recommendation: leave it.** If the
history UI later needs entry-level risk without an engine, revisit; until then `entryRisk` is one
side map versus a change to the type every consumer imports.

**∆21 — Doc 04 §10.1's wording on index/constraint stubs is right in intent, wrong in detail.**
*Change doc 04* §10.1. It says an index or constraint referencing only masked fields is "kept, so
the PK badge still renders". Doc 05 §8.3 agrees it is kept, and adds what does **not** survive:
`name: ''` (no `idx_emp_salary`), `engineProps: {}`, expression columns dropped, marked restricted.
*Demanded by* D05 §14 row (b), which explicitly says both documents agree on intent and doc 04's
wording should say so.

---

## 6. Consolidated open questions

47 questions, merged and de-duplicated from 65 raw items (items marked Closed in
their source document are omitted; doc 03's cross-document dependencies 1–8 moved
to §5). **Ranked by how much rework a wrong answer costs.** Each carries a
recommended default written so that silence is an approval.

### Tier 1 — changes the database or the permission model after data exists

| # | Question | Options | **Default if you say nothing** |
|---|---|---|---|
| Q1 | Workspace-level sharing. C5 fixes the grantable set to `project \| area \| entity`, so "share this workspace with Analysts" expands to N project grants that do not auto-apply to later projects. `[D05 OQ2]` | Add a fourth resource type and a fourth level to the chain now; or expand to N grants | **Do not add it.** Cheap now, expensive after launch — but nothing in Phases 1–4 needs it, and a fourth level touches the resolver, the cascade, the matrix and the dialog. Revisit the moment a customer asks. |
| Q2 | `docs` / `comments` polymorphism. `target_type`/`target_id` per spec §9, or an exclusive arc of four nullable FK columns with `num_nonnulls(...) = 1`. `[D02 OQ1]` | Polymorphic (spec) or exclusive arc (real FKs, DB-enforced project membership, deletes `purge_polymorphic_refs`) | **Keep polymorphic, per spec §9.** One convention beats two. Noted as the cheapest thing in the schema to change, so if you want the FKs, say so before `0001` is written. |
| Q3 | Client-generated ids. The server accepts a caller-chosen primary key; C1 says cuids without saying who mints them. `[D04 OQ6]` | Client-minted (current) or server-minted + client temp ids + an id map in the response | **Keep client-minted.** The server rejects collisions and stub-prefixed ids and owns every tenancy column; the alternative is significantly more code in the canvas store. |
| Q4 | Area geometry. `Area.rect` is deleted and the canvas derives a region from members' bounding box. An empty Area lives only in the sidebar legend. `[D04 OQ2]` | Derived (current) or four geometry columns on `areas` and drag-into-rectangle membership | **Keep derived.** Hand-drawn areas are a different product gesture; adding the columns later is additive, removing them is not. |
| Q5 | `isPii` and `isDeprecated` as core IR columns. `[D04 OQ4]` | Core columns (diffable, filterable, `governance` / `documentation` severity) or structured docs facts | **Keep them core.** Matches C4's treatment of `isRestricted`; cheap to change now, painful once snapshots exist. |
| Q6 | Who may set `isRestricted` / `isPii`. R20 requires `schema:edit` + `field:viewRestricted` to set and `sharing:manage` to unset; spec §6.2 files "Restricted" under structured field docs, implying `docs:edit`. A Documenter therefore cannot flag a column as PII. `[D05 OQ5 + D04 OQ13]` | Keep R20; or add one row to D04 §8.5 (`update field`, patch ⊆ `{isPii, isDeprecated}` → `docs:edit`); or split into propose/confirm | **Keep R20 for `isRestricted`, and add the one §8.5 row for `isPii`/`isDeprecated`.** Classifying fields is a documenter's job; un-restricting one is not. |
| Q7 | `canViewRestricted` as a per-grant boolean rather than a custom role. `[D05 OQ1]` | Keep the column; or require a custom role per person who may see a salary column | **Keep the column.** If a third modifier ever appears, both booleans become a constrained `extraAtoms PermissionAtom[]`. |
| Q8 | Per-field ACLs. Restriction is all-or-nothing per grant — no "Ana may see `salary` but not `ssn`". `[D02 OQ6]` | All-or-nothing (spec §5) or per-field ACLs | **All-or-nothing.** Per-field ACLs multiply the grant table by the field count. First thing an enterprise customer will ask for; say no now, deliberately. |
| Q9 | Org admins can always read restricted fields (R13). `[D05 OQ3]` | Keep; or add break-glass (self-elevate, time-boxed, audited); or a deny mechanism (R14 rejects it) | **Keep R13.** Out of scope for v1. Compliance regimes requiring "administrators cannot read PII" get break-glass later, never a deny grant. |
| Q10 | Audit-log retention after an org is deleted. Rows survive with `organization_id = NULL`. `[D02 OQ3]` | A retention period + whether the trail must be exported before it is dropped | **24 months, export-on-request, deletion by a reviewable retention job.** This is a contract/GDPR answer the schema cannot supply; the schema works either way, but the job needs a number before launch. **Decided and built 2026-09-29:** every `audit_log` row older than 24 months is deleted, for live and deleted orgs alike (not only orphaned rows). The nightly `audit.retention` job on the `maintenance` queue (`apps/api/src/jobs/audit-retention.processor.ts`, 03:15 UTC) touches `audit_log` only, and records each sweep as an `audit.retention_swept` row. |
| Q11 | Id arrays inside JSON columns are unswept: `ai_threads.selection`, `ai_messages.metadata.*`, `comments.mentioned_ids`, `docs.structured.ownerUserId`. `[D02 OQ5]` | Best-effort (readers drop unresolvable ids; the AI thread tells the user) or promote `ownerUserId` to a real column with `SetNull` | **Best-effort, as designed.** Promote `ownerUserId` only if a "fields I own" screen ships. |
| Q12 | Snapshot access is project-scoped only, so an area-scoped Editor cannot use history at all. `[D02 OQ4 + D05]` | Keep (the IR blob is opaque, `VisibilityFilter` cannot filter it) or build a filtered history view | **Keep project-scoped.** The conservative reading of spec §5, and the only one that is not a leak. |
| Q13 | Production domain topology. `app.` + `api.` under one registrable domain is assumed, and §5.4's CORS/cookie design depends on same-*site*. `[D01 OQ1]` | Same apex (current) or a different-apex API (`SameSite=None` on session cookies, middleware presence re-thought) | **Confirm same apex.** Needs an answer before `AuthModule` is written. **Decided 2026-09-29: same HOST, not just same apex.** Web and api share one hostname behind a proxy (`/api`, `/socket.io`); the api refuses to boot otherwise. Two subdomains were reproduced to loop on /login, because RSC pages forward the browser's cookies and `sl_access` is host-only on the api host. See `docs/deploy.md`. |
| Q14 | Hosting target. No `infra/`, no app Dockerfile, no production collation pinned on Postgres. `[D01 OQ5]` | Vercel-for-web + container host for api; or one container/VM (`apps/web` in `standalone` output) | **Vercel + container API**, and pin the Postgres collation before the first production database is created — collation cannot be changed in place. **Built 2026-09-29:** `apps/api/Dockerfile`, ICU `en-US` collation; see `docs/deploy.md` and `docs/self-host-ubuntu.md`. Vercel was dropped with Q13's one-host decision. |

### Tier 2 — changes a published contract or a package boundary

| # | Question | Options | **Default if you say nothing** |
|---|---|---|---|
| Q15 | `engineVersion` semantics, and whether engine `version` is the npm version. `[D04 OQ7 + D03 OQ15]` (merged) | — | **Three distinct fields, all kept: `Project.engineVersion` = target database ("16"); `EngineDefinition.version` = the behaviour contract, an explicit field, not derived from `package.json`; `Project.enginePluginVersion` = the contract version the stored `engineProps` were written under.** Two version numbers on one package invites confusion; lockstep with `package.json` invites a worse one. |
| Q16 | Literal "engines register themselves at startup" (spec §3.2) is not implementable without a side-effecting import. A one-line manifest outside `EnginesModule` is substituted. `[D01 OQ2]` | Accept the manifest or add a registration side effect to `EngineDefinition` | **Accept the manifest.** The property the spec wants — no changes to core modules — holds, because `engines.manifest.ts` is not part of `EnginesModule`. Flagged loudly per C12. |
| Q17 | Engine DTOs live in `engine-sdk`, not `contracts`, because C10 declares no `contracts → engine-sdk` edge. `[D03 OQ10]` | Keep; or add the edge (still acyclic) and re-export | **Keep them in `engine-sdk`.** Adding the edge is additive and reversible; moving types is not. |
| Q18 | Terminology lives on the client facet, deviating from the brief, which put it under the UI plugin. `[D03 OQ8/OQ11]` | Keep on the facet or move to the UI plugin | **Keep on the facet.** Moving it costs wrong nouns in the fallback UI for any engine without a UI package. |
| Q19 | The first engine major bump has no migration path: the project opens read-only until an operator runs a job that does not exist yet. `[D03 OQ17/OQ5]` | Accept, with a commitment to write the job before the first breaking change; or build machinery now | **Accept — and this is the one item that wants an explicit yes rather than silence.** It is correct for a v1 with one engine at major 1, but it is a promise to write that job *before*, not after. **Built 2026-09-29:** `EngineDefinition.propsUpgrades` (one step per past major, checked by `props/previous-major-migrates`), `EngineGate.checkWrite` on both schema writers (423 when read-only; refreshes a same-major version), and the operator command `node dist/engine-upgrade.cli.js --all` (`apps/api/src/engines/engine-upgrade.ts`): one locked transaction per project, every row validated against the new schemas, all-or-nothing. |
| Q20 | Two engine-SDK signatures and `redact` module placement. `[D05 OQ9]` | — | **Settled; recorded here only.** Both take `RedactedModel`; `redact` / `RawSchemaModel` / `VisibilityContext` live in `packages/schema-model`. See ∆3 for the remaining naming fix. |
| Q21 | `DOC_EXCERPT_CHARS = 200`, and `FieldDocFacts` dropped from the IR (consumers fetch the doc row). `[D04 OQ5 + D04 OQ3-related]` | Confirm 200 or name a number | **Confirm 200.** Keeps a fully documented 300-entity project under ~2.3 MB (~250 KB gzipped) and is long enough for a search snippet and a hover card. |
| Q22 | Import `maxBytes` per format. No number picked; 50 MB PostgreSQL dumps exist. `[D03 OQ16/OQ10]` | — | **5 MB synchronous, larger via the BullMQ import job.** The four merge questions (collision key, doc retention, position retention, grant/comment retargeting) belong to the import/export document, not Phase 1. |
| Q23 | IR payload size for a 300-entity project is unmeasured. `[D01 OQ3]` | — | **Measure before Phase 1 closes, and give it an owner.** Above ~1 MB gzipped the canvas query must be paginated by area *before* the canvas ships. A measurement, not a decision — but it constrains doc 04. **Measured 2026-09-29** (`apps/api/src/schema/ir-size.spec.ts`, doc 04 §12's worst case, random cuid ids): `/ir` 2.1 MB raw, **~380 KB gzipped**; `/ir/canvas` ~27 KB. No pagination needed. The api now gzips responses itself (`compression`, SSE excluded), and the spec fails if the IR passes 1 MB gzipped. |
| Q24 | Quick-fix edit union is deliberately five ops; "add the missing index" is not expressible. `[D03 OQ13]` | — | **Keep five.** Extending it later is additive. |
| Q25 | `activity_log` and `audit_log` overlap and could collapse into one table. `[D02 OQ2]` | Two tables (different scope key, retention, deletion behaviour) or one | **Keep two.** Compliance retention is a different conversation from a feed, and spec §9 names both. |
| Q26 | `AccessRequest.requestedRoleKey`, `ShareLink.useCount`/`lastUsedAt`, and `email_invite` as a fourth `PrincipalType` all have thin or no consumers. `[D05 OQ10]` | Keep or trim | **Keep all three.** C5 names `email_invite`; the other two are doc 02's columns and cost one column each. |
| Q27 | Ten late-added columns (seven `refs`, `engine_plugin_version` x2, `schema_revision`). `[D02 OQ10]` | — | **Keep them; drop `schema_revision` if diagnostics caching is cut from Phase 1.** It is the softest of the ten — its only consumer is the diagnostics cache key. |

### Tier 3 — scope and phasing

| # | Question | Options | **Default if you say nothing** |
|---|---|---|---|
| Q28 | Phase 1 auth carries five login paths (magic link, Google, GitHub, TOTP, recovery codes, device sessions) before there is a user. `[D01 OQ8]` | Build all (as spec'd and as designed) or cut to password + email verification + one OAuth, rest to Phase 3 | **Cut to password + email verification + one OAuth for Phase 1.** Every Phase 1 workflow is covered; the env vars and the module are already designed for the full set, so the rest is additive. This is the single largest scope reduction available. |
| Q29 | Exports are project-scoped, so an area-scoped freelancer cannot export at all. `[D05 OQ6 + D05 OQ8]` | Add `POST /areas/:id/exports` (small) or defer | **Defer.** Not in the spec; revisit when a customer hits it. **Built 2026-10-01** (server formats only; see `docs/ROADMAP.md`). |
| Q30 | BullMQ processors run in the api process. `[D01 OQ6]` | Keep or split `apps/worker` | **Keep in-process.** The split is an `apps/worker` importing `JobsModule` and nothing else; *when* is a load question, not a design one. |
| Q31 | Phase 1 e2e runs Chromium only. `[D01 OQ10]` | — | **Chromium only.** Firefox and WebKit roughly quadruple e2e wall clock. Say if a cross-browser matrix is a release requirement. |
| Q32 | Serial integration tests (`fileParallelism: false`) put a ceiling on the suite. `[D01 OQ9]` | Accept the ceiling or build schema-per-worker now | **Accept it.** The upgrade is confined to `test/setup/`. Agreeing now matters mainly so nobody "fixes" the slowness by re-enabling parallelism and adding retries, which restores the race and hides it. |
| Q33 | No Turborepo remote caching in Phase 1. `[D01 OQ11]` | — | **No remote cache.** Revisit when CI passes ~10 minutes or the team grows past a few people. |
| Q34 | `exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature` are off. `[D01 OQ7]` | — | **Leave them off.** Both cause real friction with Prisma's optional-nullable outputs and React prop spreading. Turning them on later is a mechanical, if tedious, pass. |
| Q35 | Batch idempotency. A timed-out batch is resolved by refetching, never blind retry. `[D04 OQ8]` | — | **Do not build it.** The trigger is telemetry showing frequent timeouts; the upgrade is a narrow `applied_batches(batch_id PK, …)` TTL table written in the same transaction. Deliberately not the op log. |
| Q36 | Cross-namespace and cross-project rename detection does not exist (no heuristic at all). `[D04 OQ10]` | — | **Defer to Phase 4**, which owns the candidate generator and the confirm UI — and must re-derive weights that can actually reach their threshold for entities. Same-project diffs are saved by id matching, so this bites only imports and cross-project comparisons. |
| Q37 | Rate-limit tiers per role and permission-expiry notifications. `[D05 OQ11]` | — | **Not designed, deliberately.** Both are additive and neither changes the resolver. |
| Q38 | `export:run` is in every built-in role, including `viewer`. `[D05 OQ4]` | — | **Leave it.** A viewer can already read everything on screen, so withholding export is theatre. A no-export viewer as a *built-in* breaks the R2 chain and adds a second axis to the matrix; use a custom role for the DLP case. |

### Tier 4 — acknowledged risk, tuning, or documentation

| # | Question | **Default if you say nothing** |
|---|---|---|
| Q39 | Composite custom types are not redacted; a composite mirroring a hidden entity's columns is a real leak vector. `[D05 OQ7]` | **Accept for v1.** Type names are shared vocabulary; hiding them breaks visible entities that use them. Revisit if composites turn out to model private records. |
| Q40 | Two residual leaks stated, not solved: L21 (hide-mode name-collision oracle — the reason `mask` is the default) and L26 (free prose in documentation naming an invisible object). `[D05 OQ7/OQ14]` | **Accept, and put both in the customer-facing security documentation, not only in doc 05.** L21 is irreducible; nothing can redact an English sentence. |
| Q41 | Nesting depth is capped only by `MAX_FIELD_DEPTH` in the application; the database does not consult `supportsNestedFields`. `[D02 OQ8]` | **Accept.** The validator is load-bearing for integrity, not just UX. The cycle check is structural (the `UNION` CTE), so only the ceiling is application-enforced. |
| Q42 | `sortPath` ordinal width is 4 digits because ordinals are dense. `[D04 OQ9]` | **Keep dense ordinals.** If gap ordinals (1000, 2000) are ever adopted, the width must widen with them or lexicographic ordering breaks silently. Leave a comment saying so. |
| Q43 | `approxTokens` is a character-count heuristic, not a tokeniser. `[D03 OQ14]` | **Keep the heuristic.** If AI usage billing needs exact numbers, core calls the provider's token-counting endpoint and the field becomes advisory. |
| Q44 | `'wide-column'` in `EngineParadigm` has no planned engine, and `paradigm` appears only in the picker card and the AI system prompt. `[D03 OQ12/OQ6]` | **Keep both, because the spec asks for them — but `paradigm` must never become a switch target.** Worth a lint rule if it ever appears in a `switch`. |
| Q45 | `MatchStrategy`, `SnapshotRef.kind: 'import'`, and `irVersion` + `upgradeModel` (empty switch in v1) are pure future-proofing. `[D04 OQ11]` | **Keep all three.** Snapshots are permanent data, and retrofitting a version tag onto blobs already in production is the classic version of this mistake. |
| Q46 | Over-built but spec-mandated in the schema: `custom_types`, the general `constraints`/`constraint_columns` shape, `link_cardinality` as a database enum, and the empty `doc_drafts` / `export_jobs` tables. `[D02 OQ7]` | **Keep all of them.** An empty table costs nothing; a retrofit costs a release. Note that `custom_types` brings the `fields.data_type` denormalisation rule with it, which is the sharpest maintenance edge in the schema. |
| Q47 | Type names in `packages/engine-sdk/src/ir.ts` are verified against doc 04 as written today. `[D03 OQ9]` | **No action.** If doc 04 moves after review, that one file is the entire integration diff. |

---

## 7. Phase 1 build order

Dependency-correct. Sizing is rough developer-days for one person who has read the
five documents. **Step 0 is the punch list in §5** — every later step compiles
against types that §5 corrects, so doing it first is cheaper than doing it at all.

| # | Step | Depends on | Size | Notes |
|---|---|---|---|---|
| 0 | Apply §5 deltas to the five documents | — | 1 | ∆1–∆7 are blocking; ∆17 wants a read of doc 02 §1 first |
| 1 | Repo skeleton: pnpm workspace, `packages/config` (JS+JSON, no build), `turbo.json`, tsconfig presets, ESLint flat config, `.env.example` | 0 | 2 | Nothing else can be built until `packages/config` exists and does not need building |
| 2 | `docker-compose.yml` + root `.env` interpolation, `.nvmrc`, CI skeleton (three jobs, service containers) | 1 | 1 | CI before code, so it never has to be retrofitted around a green build |
| 3 | `packages/contracts` part 1: `PERMISSION_ATOMS`, `PermissionAtom`, `closeAtoms`, `BUILT_IN_ROLES`, `BUILT_IN_ROLE_ORDER`, `BUILTIN_ROLE_IDS`, `permissionAtomSchema`, `notificationTypeSchema`, `MAX_FIELD_DEPTH` | 1 | 1 | No dependencies on anything else; unblocks 4 and 8 |
| 4 | Prisma schema `0001_init` (all ten schema tables + auth/tenancy/content/permissions/logs), `0002_constraints_and_partial_indexes` (hand-written: five deferrable FKs, partial uniques, named CHECKs, three trigger functions), `0003_builtin_roles` | 3 | 5 | The whole permission model ships in `0001` (decision 48). `db:verify` asserts `condeferrable` on the five FKs |
| 5 | `packages/schema-model` part 1: the eight object types, all zod schemas, `IrBase` (with ∆1's `refs`), `TypeRef`, `DocRef`, `IR_OBJECT_TYPES`, `Id` | 3 | 3 | Pure types + zod; no database |
| 6 | `packages/schema-model` part 2: eleven `*Row` types, `assembleModel`, `ModelIndex` + `createIndex` + traversal helpers, `validateModel` | 4, 5 | 4 | `assembleModel` is engine-free by construction (decision 73) |
| 7 | `packages/engine-sdk` part 1 (`.` entry): `EngineDefinition`, `EngineStaticFacet`, `EngineCapabilities` + `defineCapabilities` (15 invariants), `TypeCatalog`, `propsSchemas`/`parseEngineProps`, `checkLink` + link rules, `errors.ts`, `Diagnostic` + `renderDiagnostic`, `extractReferences`, `normalizeName` (∆6), `compareEngineVersion` | 5 | 5 | Do not build importer/exporter/migration/AI yet |
| 8 | `apps/api` skeleton: Nest bootstrap, `env.ts` boot validation, `PrismaModule`, `RedisModule` (three clients, prefixes, TTL), `nestjs-zod` + `patchNestJsSwagger`, health route | 2, 3, 4 | 2 | |
| 9 | `AuthModule` (reduced per Q28: password + email verification + one OAuth), cookies `sl_access` / `sl_refresh` / `sl_presence` / `sl_csrf` / `sl_session` (∆11), CSRF middleware | 8 | 4 | |
| 10 | `AccessModule`: `PermissionResolver` (R1–R29 incl. the step-4b downward `sharing:manage` union), `ProjectPermissionMap` + `entityOverrides`, `ProjectSkeleton`, generation counters read from Postgres, Redis caching with `validUntil`-derived TTL | 4, 8 | 6 | The resolver before the guard, the guard before any route |
| 11 | `PermissionGuard` + the five route decorators (∆7 signature), the two `APP_GUARD`s in fixed order, the boot-time route sweep + `SHARE_LINK_ROUTES` allow-list assertion | 10 | 2 | A route cannot exist before the sweep can classify it |
| 12 | `VisibilityFilter` + `redact` / `RawSchemaModel` / `RedactedModel` in `packages/schema-model` (∆3), the `redacted !== true` interceptor, `assertRedacted` on socket and export paths | 6, 10 | 4 | **Nothing that serves schema data may be written before this exists** |
| 13 | Schema read path: `SchemaLoader`, the eleven parallel `project_id` scans, `GET` project/canvas routes through `VisibilityFilter` | 11, 12 | 2 | |
| 14 | Schema write path: `SchemaOperation` batch endpoint, `requirementsOf(op, live)`, visibility-before-version check, cascade post-images, server-assigned `ordinal`, geometry endpoint (no version read/bump) | 13 | 5 | |
| 15 | `EnginesModule` + `engines.manifest.ts` + `createEngineRegistry` + `GET /engines` | 7, 8 | 1 | |
| 16 | `packages/engines/postgresql`: `.` and `/static` split, `splitting: true`, preserved dynamic `import()` of `libpg-query`, type catalog, props schemas, link rules, terminology, `extractReferences`, validator | 7, 15 | 8 | The largest single package |
| 17 | `packages/engine-sdk/conformance` + `runEngineConformance` (∆9, ∆10) and the PostgreSQL fixture set | 16 | 3 | Must pass before the engine is considered done |
| 18 | Diff engine: `diffModels`, `deepDiff`, `sortPath`, four severities, id → logical key → pinned matching, selectors | 6 | 4 | Independent of the API; can run in parallel with 8–14 |
| 19 | Snapshots: write, read, diff (project-scoped `history:view`), restore (`opsFromDiff(diff, live)`, `schema:edit`, R28 freeze, 409 `project_restored`), `enginePluginVersion` stamping | 14, 18 | 3 | |
| 20 | Exporter (DDL/JSON/Markdown server-side) taking `RedactedModel`, `EXPORT_PHASE_ORDER`, deterministic total ordering, `ExportResult.incomplete`, `export_jobs` + S3 presigned PUT | 12, 16 | 4 | |
| 21 | Importer + statement-level report | 16, 14 | 4 | |
| 22 | `apps/web` skeleton: App Router, three route groups, middleware presence check, `api-client.ts` with CSRF echo, `packages/ui` primitives, Tailwind v4 tokens | 1, 9 | 4 | |
| 23 | `createEngineFacetRegistry`, `EngineProvider`, `useEngine`, `useTerminology`, `EngineUiRegistry` + code splitting, `FALLBACK_ENGINE_UI` | 22, 16 | 3 | |
| 24 | Canvas: server shell + client store, entity/field rendering via `EngineNodeProps`, link drawing, `checkLink` mid-drag, property panels, geometry autosave | 23, 13, 14 | 10 | The long pole |
| 25 | Sharing UI: grants dialog, share links, access requests, the narrowing-grant warning from `resolveResource` | 24, 10 | 4 | |
| 26 | BullMQ jobs in-process: whole-model validation, export rendering, email | 8, 20 | 2 | |
| 27 | The permission matrix generator + committed CSV snapshot, property tests (P8, P9, P12, P13), integration and e2e suites | 11, 12, 24 | 5 | |

Rough total: ~110 developer-days of implementation, excluding review and the
measurement in Q23.

### Deferred to Phases 2–5

- **Phase 2** — `touchedEntityIds` / `touchedFieldIds` on `saved_queries` and `ai_messages` (the columns can land with Phase 2 per D05); saved queries and `QueryValidator`; the `queryValidation` capability path.
- **Phase 3** — custom roles (storage, validation on write, the archived-role path); `email_invite` grants reaching the resolver (R11); guest accounts; the remaining login paths cut in Q28 (magic link, second OAuth provider, TOTP, recovery codes, device-session management).
- **Phase 4** — realtime over WebSocket (the transition model in decision 105 is designed now, wired then); the rename candidate generator and confirm UI; the diff/history document; `apps/worker` split if load demands it.
- **Phase 5** — `MigrationGenerator` and `AnnotatedDiff`-driven migration plans; AI (`AiProfile`, SCS serialisation, tagged-block streaming, `doc_drafts` per-suggestion accept/reject); PDF export; documentation mode beyond `DocRef`.
- **Unscheduled** — the engine major-bump migration job (Q19), schema-per-worker integration tests (Q32), Turborepo remote caching (Q33), area-scoped export (Q29), workspace-level sharing (Q1).

---

## 8. Deliberately not building

The YAGNI cuts made during the design pass. Listed so you can object before they
become expensive to reverse. Everything here is **additive later** unless marked.

**Cut from the engine SDK `[D03]`**
- 23 of 33 feature atoms — every atom a descriptor already answered (`enforcedLinks`, `compositeLinkEndpoints`, `linkFields`, `uniqueIndexes`, `arrayTypes`, `namespaces`, `views`, `materializedViews`, `schemalessEntities`, all four constraint atoms, all three customType atoms, `import`, `export`, `introspection`) plus the consumerless ones (`fieldOrderMatters`, `defaults`, `collations`, `identityFields`, `generatedFields`, `partialIndexes`). Replaced by 12 derived helpers.
- The entire upgrade-on-open subsystem: `propsMigrations`, `EnginePropsMigration`, the transaction, `engineUpgradePending`. Four race conditions deleted rather than fixed.
- `Introspector` and `features.introspection`. (Brought back as a smaller contract in Phase 6,
  approved 2026-09-29: `docs/phase6/DESIGN.md`.)
- Server-version-targeting knobs: `TypeDescriptor.since`, `ExportFormatDescriptor.targetVersions`, both `targetVersion` options.
- `term` on all four kind descriptors (Terminology is the single home for nouns).
- `AiOutputFormat` and `AiOutputFormat.kind`, `'generic-brackets'`, `AiPromptContext.capabilities`.
- `hasFeature`, `EngineUiRegistry.peek`, `TerminologyBundle.overrides`, `ImportFormatDescriptor.mimeTypes`, `EntityKindDescriptor.userCreatable`.
- The `views` phase in `EXPORT_PHASE_ORDER`.
- `ValidationTrigger` — nothing branched on it.

**Cut from the IR `[D04]`**
- The entire rename heuristic: `RENAME_WEIGHTS`, `RENAME_THRESHOLD`, `RenameSuggestion`, `renameSuggestions`, `detectRenames`, `confidence`, Levenshtein, greedy assignment. It could not detect an entity rename at all.
- `TypeRef.display`.
- `FieldNode`, `fieldTree`, `formatNamePath` escaping, `FieldDocFacts`, `RestrictionMark`, `hasEngineProps`, `LinkEndpoint.role`, `ID_SHAPE`, `ENGINE_PROPS_REFERENCE`, `LINK_EMPTY_ENDPOINT` (merged into `LINK_ARITY`).
- Ten `= string` id aliases, `OpenKind` and five kind aliases.
- `Area.rect` — **not freely additive**: adding hand-drawn areas later changes the canvas gesture as well as four columns.

**Cut from the schema `[D02]`**
- `fields.depth` and its two CHECKs; `permission_atom` and `notification_type` Postgres enums; the generic dynamic-SQL trigger function; the link-purge trigger; `snapshots.entity_count`; `users.locale`; `areas.description`; the `fields(project_id, is_restricted)` index; the canvas/budget/TOTP settings keys; two empty zod branches; `sessions.share_link_id`.
- A `comment_mentions` join table (a `text[]` read whole instead).
- Exclusive-arc FKs for `docs`/`comments` — see Q2, the one cut that is **not** cheap to reverse once `0001` has run.

**Cut from permissions `[D05]`**
- The HMAC stub-token scheme in full: `stubKey`, HKDF, the `*st_` DTO ban, the rotation story.
- `ProjectSkeleton.fieldsByEntity`; the materialised `entityAtoms` / `visibleEntityIds` / `restrictedOkEntityIds` fields on the cached map.
- The Redis generation mirror.
- Deny grants (R14), permanently — they break monotonicity in principals, which is what makes group unions and caching sound.
- Rate-limit tiers per role; permission-expiry notifications.

**Cut from tooling `[D01]`**
- Changesets, versioning, `publishConfig`; TypeScript project references; `tailwind.config.ts`; a Next proxy / route handlers / Server Actions; `strict-peer-dependencies`, `prefer-workspace-packages`, `link-workspace-packages`; `POSTGRES_INITDB_ARGS`; Turborepo remote caching; five env rows moved to code constants; `infra/` and app Dockerfiles (pending Q14).
