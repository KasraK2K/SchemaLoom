# First-run experience: templates and sample projects (roadmap 12)

Status: **built** (approved 2026-10-02 with every default in §7, built the same day).

**As built:**

- The three templates live in one file, `packages/engines/postgresql/src/templates.ts`,
  not a folder of one file per template.
- **A bug fix found on the way.** Importing any `CHECK` through the API failed with 422
  `engine.props-invalid`. The API checked constraint props with no sub-kind, while the
  PostgreSQL engine and the conformance suite pick the schema by `Constraint.kind`, so a
  CHECK's `expression` was rejected. `props-validation.ts` and `engine-upgrade.ts` now pass
  the constraint's kind, and the SDK says so (`props.ts`).
- e2e workflow 1 was updated for the Target version dropdown (commit 17e146b), which it
  still tried to type into.

## 1. Problem

A new owner signs up, creates an organisation, and lands on "Nothing here you can open yet"
with three cards: Start blank, Import SQL, Read a database. All three assume they already
have a schema or the patience to draw one. Someone who just wants to see what SchemaLoom
does has nothing to click.

Inside a project it is the same story. The empty canvas shows three cards, and the third,
**Describe your app**, is permanently disabled even though the AI draft-schema feature
(Phase 5, `POST /projects/:id/ai/draft-schema`) is built and already works inside the import
dialog.

## 2. The idea in one paragraph

A **template is a SQL file the engine ships**. Starting from one is exactly "Import SQL"
with the text already filled in: the web app creates the project, then calls the existing
`importInto`. No new import path, no new write path, no seed-style row inserts. Imported
tables already arrive at the origin and the canvas lays them out on first open
(`unstack` → `'all'` → elk), so a template project opens arranged.

There is no separate "sample project" mechanism. The e-commerce template **is** the sample
project: one click, and you have a real, editable schema to explore.

## 3. What the user sees

### 3.1 Projects page (`NoProjects`)

- A fourth card, **Start from a template**: "A small, realistic schema to explore or build
  on. You can change everything." The grid is already two columns, so four cards fit.
- Clicking it opens the same form as the other cards with a **Template** select at the top
  (title + one-line summary + table count). Choosing a template pre-fills **Name** with the
  template's title, if the user hasn't typed one. Engine and target version work as they do
  today; only engines with templates are offered.
- Submit → **Create project** → `createProject()` then
  `importInto(id, source)`, reusing the retry-safe `createdId` logic. If anything is skipped
  (it shouldn't be, see §6), the existing "Imported, with N statements not applied" panel
  shows.
- The intro line changes from "Nothing here you can open yet." to "No projects yet. Pick a
  way to start." when the caller can create projects. Guests keep the old line.

### 3.2 Empty canvas (`CanvasEmptyState`)

- **Describe your app** is wired up. It opens the import dialog with the Describe box
  focused (`DescribeSchema` already lives there). It is enabled when the caller can import
  and the engine has an `aiProfile`. If the AI provider isn't configured, the API's existing
  error shows in the dialog, as it does today.
- The import dialog gets a **Load a template** select next to Describe. It fills the SQL box
  the same way Describe does. The user still reviews it, and the usual preview and additive
  merge run on Import.
- The `project {projectId}` debug footer on the empty state goes.

## 4. Where it lives

### 4.1 Engine SDK

```ts
// packages/engine-sdk/src/templates.ts
export interface ProjectTemplate {
  readonly id: string; // kebab-case, unique within the engine, stable
  readonly title: string; // 'E-commerce'
  readonly summary: string; // one line for the picker
  readonly tableCount: number; // shown in the picker; conformance checks it
  readonly importFormat: string; // one of capabilities.importFormats
  readonly source: string; // the SQL
}
```

- `EngineDefinition.templates?: readonly ProjectTemplate[]`, on the **server half**, not the
  static facet. The browser never loads the SQL it isn't going to use.
- `EngineDescriptor` (what `GET /engines` returns) gains
  `templates: { id, title, summary, tableCount }[]`, with no `source`. Engines without
  templates return `[]`.

### 4.2 PostgreSQL engine

`packages/engines/postgresql/src/templates/` has one TypeScript file per template, each
exporting a `ProjectTemplate` whose `source` is a template literal. TS strings rather than
`.sql` files means no tsup loader change. Three templates, 5–8 tables each, written to show
off what the canvas does (FKs, a composite key, an enum, a CHECK, a unique index, a partial
index):

| id          | Tables                                                                              |
| ----------- | ----------------------------------------------------------------------------------- |
| `ecommerce` | customers, addresses, products, orders, order_items, payments (`order_status` enum) |
| `saas`      | organizations, users, memberships (composite PK), plans, subscriptions, invoices    |
| `blog`      | authors, posts, tags, post_tags, comments                                           |

The e-commerce one follows the seed's schema (`apps/api/prisma/seed.ts`) so the two tell
the same story, but the seed itself is untouched: it inserts fixed ids that e2e depends on.

### 4.3 API

One route, in `engines.routes.spec.ts`:

| Route                                          | Marker             | Does                                                    |
| ---------------------------------------------- | ------------------ | ------------------------------------------------------- |
| `GET /engines/:engineId/templates/:templateId` | `@Authenticated()` | `{ importFormat, source }`; 404 if either id is unknown |

`@Authenticated` matches `GET /engines`. Templates are engine data, not project data, so
there's nothing to permission-check and nothing that passes through `VisibilityFilter`. The
import that follows goes through the existing `POST /projects/:id/import`, with its own
`schema:edit` check, `SchemaWriter`, protected-project rule (a brand-new project is never
protected) and engine gate. **No migration.**

### 4.4 Web

- `create-project.tsx`: the fourth card, the template select, and a `fetchTemplate()` that
  calls the route above. The submit path is the existing import branch.
- `empty-state.tsx` / `canvas-surface.tsx`: an `onDescribe` handler that opens the import
  dialog in describe mode.
- `import-dialog.tsx`: the **Load a template** select.
- No engine id or template id is hard-coded; both come from `GET /engines`.

## 5. Out of scope

- **Docs in templates.** `COMMENT ON` is "ignored" by the importer today (the reason string
  says the docs module should import it, and it doesn't yet). Templates ship without object
  docs. Importing comments into docs is its own small feature, and it helps every import, not
  just templates. _Built 2026-10-02 as a follow-up:_ the importer returns `ImportResult.docs`
  and `SnapshotsService.importSource` writes them through `DocsService.importDocs`, additively.
  The three templates now ship `COMMENT ON` for their tables and key columns, so a template
  project opens documented.
- **Areas in templates.** SQL can't carry SchemaLoom areas. A template could later grow an
  `areas: { name, tables[] }[]` field applied after import; not now.
- **Auto-creating a sample project** for every new org. That clutters real orgs, and in
  invite mode (roadmap 16) most orgs are real from day one.
- **Org-defined templates** ("save this project as a template"). Wait for someone to ask.
- **A guided tour or onboarding checklist.** The cards are the onboarding.

## 6. Tests

- **Engine conformance** (`engine-sdk/src/conformance`), for any engine with templates:
  unique ids; `importFormat` is in `capabilities.importFormats`; the source imports into an
  empty model with **every statement `applied`** (nothing skipped, nothing unsupported);
  the entity count equals `tableCount`; and the result exports without diagnostics. This
  is what stops a template from rotting when the importer changes.
- `registry.spec.ts`: the descriptor lists template metadata and never `source`.
- `engines.routes.spec.ts` plus a controller spec: the source comes back, and unknown
  engine or template is 404.
- `projects-render.spec.tsx`: the fourth card; it's disabled when no engine has templates;
  picking a template pre-fills the name.
- e2e **workflow 14**: create a project from the e-commerce template, then check the canvas
  shows its six tables and an export downloads. Second test: on an empty project, Load a
  template in the import dialog fills the SQL box.

## 7. Open questions

| #   | Question                                                 | Default                                                                                                               |
| --- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Q1  | Which templates ship first?                              | E-commerce, SaaS (multi-tenant), Blog. Three is enough to show the idea.                                              |
| Q2  | Does the project remember which template it came from?   | No. Once imported, it's an ordinary project. Nothing reads that link.                                                 |
| Q3  | Put the template's summary into the project description? | No. The description field isn't shown anywhere yet.                                                                   |
| Q4  | Show Describe when the AI provider isn't configured?     | Yes, enabled; the dialog shows the API's "AI isn't configured" error. A config flag on `GET /engines` can come later. |
| Q5  | Templates for Read-a-database or CLI users?              | No. They already have a schema.                                                                                       |
| Q6  | Import `COMMENT ON` into docs as part of this?           | No, separate row (see §5). Templates ship without docs for now.                                                       |
