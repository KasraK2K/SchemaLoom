# Phase 5 — migrations, AI, docs mode, PDF export

Status: **built 2026-09-28 on the recommendations below** (the user asked to implement Phase 5
directly). Every row in §6 is a default; say so if one should change.

The contracts are already designed: doc 03 §11 (`AnnotatedDiff`, `MigrationGenerator`), §12.1
(no restricted probe), §13 (`AiProfile`, SCS, tagged blocks, join paths); doc 02 (`docs`,
`doc_drafts`, `ai_threads`, `ai_messages`, `export_jobs`, `projects.settings.ai`); doc 05 L12,
L13, L25 and the `ai:use` / `docs:edit` rows. This document only adds what they left open.

---

## 1. Documentation (the Phase 1 docs panel, plus docs mode)

The docs panel from Phase 1 was never built; it lands first because AI drafting and the PDF
export both read it.

| Route                                          | Marker                                  | What                                                                                                                                                                           |
| ---------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /projects/:id/docs`                       | `@RequireProjectAccess`                 | docs mode: every **visible** doc row (project, areas, entities, fields), `content`, `plainText`, `structured`. Rows whose target is hidden or a masked field are dropped (L8). |
| `GET /projects/:id/docs/:targetType/:targetId` | `@RequireProjectAccess`                 | one doc; invisible target → 404; no row → an empty doc                                                                                                                         |
| `PUT /projects/:id/docs/:targetType/:targetId` | `@RequireProjectAccess` + service check | doc 04 §8.10: `docs:edit` at the target, `{ content, structured?, version? }`, derives `plainText`, bumps `version`, broadcasts `project:changed`                              |

- **Web:** the inspector's Docs tab gets a TipTap editor (StarterKit only) and, for a field, the
  structured facts (business meaning, allowed values, examples, unit). Read-only without
  `docs:edit` (the 403 turns the editor read-only).
- **Docs mode:** `/[org]/p/[projectId]/docs`, a third project tab. Left: tables by namespace.
  Right: the project doc, then one section per table with its doc and a column table carrying
  each field's doc and facts. "Export PDF" in the header.

## 2. PDF export

`format: 'pdf'` joins `ir-json` and `markdown` as a core format: the same structure as the
Markdown export plus the **full** doc text from `docs.plainText`, rendered with `pdfkit`
(pure JS, no browser, doc 01 §13). The docs are read under the requester's visibility, same as
docs mode.

## 3. Migrations

- `packages/engine-sdk/src/migration.ts`: doc 03 §11 verbatim (`AnnotatedDiff`,
  `entryIsDestructive`, `MIGRATION_PHASE_ORDER`, `MigrationPlan`, `MigrationGenerator`).
  `annotateDiff` and `migrationGenerator` are narrowed on `EngineDefinition`, and the six
  deferred conformance checks get bodies.
- PostgreSQL: `annotateDiff` flags removed tables/columns/types, type narrowing and
  `NOT NULL` additions; the generator emits `DROP`/`ALTER`/`CREATE` in the §11.2 order, reusing
  the exporter's `CREATE` renderers. Destructive steps are commented out unless
  `allowDestructive`.
- API: `GET /projects/:id/snapshots/:fromId/migration/:toId` and
  `GET …/:snapshotId/migration/live`, `history:view` at project scope **and the full view**
  (R21′, Q1). Query `allowDestructive=true|false`, `transactional=true|false`.
- Web: on the History screen, a "Migration SQL" toggle beside the diff shows the plan: steps
  with destructive in red and lossy in amber, "N changes need a manual step", a
  copy/download button.

## 4. AI assistant

### 4.1 Provider

The Anthropic SDK (`@anthropic-ai/sdk`) behind one `AiProvider` service in `apps/api/src/ai`.
`ANTHROPIC_API_KEY` enables it; without a key every AI route answers `503 ai_not_configured` and
the panel says so. Model is `AI_MODEL`, default `claude-sonnet-5-5` (was `claude-opus-5`; changed 2026-09-29 for cost), with adaptive thinking and
server-side `fallbacks: "default"`. The system prompt and the SCS context are the cached prefix
(`cache_control`), because SCS is deterministic (doc 03 §13.1).

### 4.2 Routes (doc 05 §2.2's `ai:use` row)

| Route                                         | Marker                                       | What                                                                                                 |
| --------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /projects/:id/ai/threads`                | `@RequireProjectAccess`                      | the caller's own threads, L25-filtered                                                               |
| `GET /ai/threads/:id`                         | `@Authenticated`                             | one thread; not own or failing L25 → 404                                                             |
| `POST /projects/:id/ai/threads`               | `@RequireProjectAccess` + `ai:use`           | `{ selection, title? }`                                                                              |
| `POST /ai/threads/:id/messages`               | `@Authenticated` + `ai:use`                  | `{ content, mode: 'query'                                                                            | 'explain' }`→ **SSE**:`block-open/delta/close`events, then`done` with the stored message (query validated, touched ids written) |
| `POST /projects/:id/ai/doc-drafts`            | `@RequireProjectAccess` + `ai:use`           | `{ entityIds }` → enqueues the `ai-doc-drafts` job; drafts land in `doc_drafts`                      |
| `GET /projects/:id/ai/doc-drafts`             | `@RequireProjectAccess`                      | pending drafts on visible targets                                                                    |
| `POST /ai/doc-drafts/:id/accept` · `…/reject` | `@Authenticated` + `docs:edit` at the target | accept writes through the docs service                                                               |
| `POST /projects/:id/ai/draft-schema`          | `@RequireProjectAccess` + `ai:use`           | `{ description }` → `{ source, importFormat }`; the client opens the existing import preview with it |
| `PATCH /projects/:id/settings`                | `@RequirePermission('sharing:manage')`       | `{ ai: { enabled, includeDocsInContext } }` (the kill switch)                                        |

`ai:use` is checked at **every selected entity** (doc 05 worked example: one unauthorised
entity → 403), and ANDed with `settings.ai.enabled`. Context is always
`aiProfile.serializeContext(redactedModel, …)`; the validator runs without a probe (L13); every
stored assistant message gets `touchedEntityIds/FieldIds` from the validator (L25); replay
re-filters the thread under the current context before each provider call.

### 4.3 Rate limits

Redis fixed windows, like share-link unlock: **30 requests per user per hour** and **300 per
org per hour**, both failing closed (Q3). `429 ai_rate_limited` with `retryAfter`.

### 4.4 Web

An **AI** tab in the inspector: thread list, a composer with the mode switch (Ask / Explain),
streamed answer with the query rendered live into the SQL editor, assumptions, validation
underline, "tables used" glowing on the canvas (the selection store), "add suggested tables".
"Save query" hands off to the existing saved-query library. A "Draft docs with AI" button on the
Docs tab and a review list (accept / reject per suggestion). "Describe a schema" in the import
dialog calls draft-schema and fills the SQL box.

## 5. Remaining work from earlier phases

From a gap audit of Phases 1–4 against docs 00, 04, 05 and phase4/DESIGN:

| Gap                                                                                                                     | Design ref                                                              | Built as                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Export API: `POST /projects/:id/exports`, `GET /exports/:id` (the processor, renderers and `export_jobs` already exist) | 00 step 20, 05 §2.2 `export:run`                                        | routes + an **Export** menu in the project header: DDL, JSON, Markdown, PDF server-side; SVG/PNG rendered client-side from the canvas and uploaded with the presigned PUT                                       |
| Docs API + editor                                                                                                       | 04 §8.10, 05 §2.2 `docs:edit`                                           | §1                                                                                                                                                                                                              |
| Search and coverage                                                                                                     | 05 §2.2, R21 ("client-side over the payload it already holds"), 04 §2.3 | both computed in the browser over the redacted model it already holds, so no route and nothing new to leak: a search box in the canvas toolbar (names + doc excerpts) and a "documented 4/9" meter in docs mode |
| `PATCH /projects/:id/restricted-field-mode`                                                                             | 05 §2.2                                                                 | `sharing:manage` at project; a select on project settings                                                                                                                                                       |
| Org members + groups: `GET /organizations/:slug/members`, group CRUD and membership                                     | 05 §2.2, §12.1; REVIEW §5 (groups, Phase 3)                             | routes + `[org]/settings/members` and `[org]/settings/groups` pages                                                                                                                                             |
| History "Show on canvas" per diff group                                                                                 | phase4 §1.2                                                             | link to `?select=<entityId>`                                                                                                                                                                                    |
| e2e `test.fixme`s (workflow 2 access dialog, workflow 3 AI)                                                             | —                                                                       | implemented                                                                                                                                                                                                     |

Not built, on purpose: `GET /entities/:id` and `GET /links/:id` (superseded by `GET /projects/:id/ir`),
server `POST …/autolayout` (layout is client-side and saved through geometry), the activity-log
screen (dropped in phase4 §0), area-scoped export (Q29, still deferred).

## 6. Questions (defaults taken)

| #   | Question                      | Default                                                                                                                        |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Who may generate a migration? | `history:view` + the full view. A migration from a partial view is a script that silently omits objects.                       |
| Q2  | AI model                      | `claude-sonnet-5-5` via `AI_MODEL` (user decision 2026-09-29; was `claude-opus-5`); adaptive thinking; `fallbacks: "default"`. |
| Q3  | AI rate limits                | 30/user/h, 300/org/h, fail closed.                                                                                             |
| Q4  | New dependencies              | `@anthropic-ai/sdk` and `pdfkit` in the api. TipTap is already in the web.                                                     |
| Q5  | Doc drafting                  | a BullMQ job (doc 02 `doc_drafts.jobId`), one draft per target, a re-run replaces the pending one.                             |

## 7. Later decisions (made by the user)

| Date       | Decision                                                                                                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-29 | **Org admins see only the projects they are granted.** R13's all-access short-circuit is owner-only (doc 05 R13, amended). Admins keep org administration (members, groups, workspaces, roles). The permission cache version went 3 → 4 so no admin keeps a cached all-access map. |
