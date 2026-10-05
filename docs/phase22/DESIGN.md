# Phase 22: Describe it, get a schema (roadmap 22)

Status: **proposed** 2026-10-05. Waiting for approval; every §9 question has a default.
**Step 1 built** 2026-10-05 (§5): **Describe with AI** in the canvas toolbar and menu.
**Step 6 built early** 2026-10-05: the projects-page **Describe your app** card (§1.2), on the
current route. It creates the project, drafts, shows the SQL to review or edit (with **Draft
again**), and **Create tables** runs the import. The summary and Refine come with steps 2–4.

The goal: a user describes what they need in plain words, from a whole application down to
one table, and the AI drafts the tables and relations. Examples:

- "A booking app for barbers: shops, barbers, services, appointments, reviews"
- "Add invoicing to this. Invoices belong to our customers and list order lines"
- "A `coupons` table that can apply to one product or a whole category"

**The backend exists; the UI barely shows it.** Phase 5 built
`POST /projects/:id/ai/draft-schema`, and the AI's DDL lands in the SQL box for the normal
preview and import. But the only ways in are a small **Describe a schema** box at the top of
the import dialog and the empty canvas's **Describe your app** card (Phase 12), which goes
away once a project has tables. Users don't find it (found 2026-10-05). This phase fixes five
things:

1. **The AI can't see the project.** `AiService.draftSchema` sends only the description.
   Asked to "link invoices to our customers", it invents its own `customers`. The additive
   import then skips that table because one already exists, so the new foreign keys can point
   at columns that don't match the real table.
2. **One shot.** A draft that's close but wrong means editing SQL by hand or starting over.
3. **Raw SQL is the only review.** Someone who can't read `CREATE TABLE` can't judge it.
4. **Not offered when creating a project.** The projects page has no Describe card; a user
   must create an empty project first and then find the card.
5. **Hidden inside a project.** Once a project has tables, nothing on the canvas says AI can
   draft schema. The box is behind **Import SQL or Prisma**, a menu entry about files.

What doesn't change: **the AI only drafts.** Its output is DDL that goes through the existing
import (preview, rename confirmation, additive merge, `SchemaWriter`), and nothing changes
until the user accepts. Existing tables are never changed or dropped by a description.

## 1. What the user sees

### 1.1 Inside a project

**A visible way in.** The canvas toolbar and the canvas right-click menu get **Describe with
AI**, next to **Import SQL or Prisma**. It opens the import dialog in describe mode, as the
empty-state card already does (`setImportFrom('describe')`). Right-clicking a selection
offers **Describe something connected to these**, which opens it with that selection as the
focus. The entries are shown when the caller can import, as the empty-state card is. The web has
no per-engine AI flag (the AI tab is always shown too), so a project without AI gets the API's
error in the dialog. As built, the selection entry waits for `focusEntityIds` (step 2):
without it, the AI can't use the selection yet.

Then the Describe box itself changes:

1. **"Build on"** under the box says what the AI will see: "Your 14 tables" or, when tables
   are selected on the canvas, "The 3 selected tables: customers, orders, products". A
   selection tells the AI where the new part connects; the AI still sees the rest of the
   project in outline (§2.2).
2. **Draft** returns a **summary first, SQL second**:
   - "Creates 3 tables: `invoices`, `invoice_lines`, `payments`"
   - "Links to existing: `customers`, `orders`"
   - "4 relations: `invoices.customer_id` → `customers.id`, …"
   - any warnings (a table it wanted to create already exists with different columns)

   The SQL sits under a **Show SQL** toggle and can still be edited.

3. **Refine** takes a follow-up instruction ("make `status` an enum", "split addresses into
   their own table") and revises the current draft, including any edits the user made to the
   SQL. Each refinement replaces the draft; **Undo** goes back one step.
4. **Import** runs the existing preview and import. Or **Propose as a change**, for users who
   can open change requests (row 10): it imports the draft into a new change request's draft,
   so the result can be checked **on a canvas** and reviewed before it reaches the project.
   That answers problem 3 without building a canvas preview.

### 1.2 On the projects page

A fifth card, **Describe your app**: "Say what you are building and AI drafts the tables and
relations. You review them before anything is created."

The form takes the name, engine and version as the other cards do, plus the description.
Submitting creates the project, then drafts, then shows the same summary, Refine and SQL as
§1.1, with **Create tables**. The project is empty until the user accepts, so it is safe to
leave. A failed or abandoned draft leaves an empty project, as **Start blank** would (Q3).

The card is shown only when some engine has an `aiProfile`.

## 2. How it works

### 2.1 The route

The existing route grows two optional fields. No new route.

```
POST /api/projects/:projectId/ai/draft-schema
{
  description: string,                  // 1–10,000 characters, as today
  focusEntityIds?: string[],            // the canvas selection, at most 50
  revise?: { draft: string, instruction: string }   // draft ≤ 100 KB, instruction ≤ 2,000
}
→ { source, importFormat, warnings, summary }
```

- **Stateless.** A refinement sends the current draft back with the instruction, so no
  thread or draft is stored and the user's own SQL edits are kept. Undo is client-side.
- **`summary`** comes from the existing import **preview** run on the AI's output against the
  project (`creates`, `existing`, `renameCandidates`), plus the foreign keys read from the
  imported draft model. The route doesn't trust the AI to describe its own output; the summary
  is what the importer actually reads.

### 2.2 The context: the project, as the assistant sees it

The prompt gains a `<schema>` block built exactly as the assistant's is (`runTurn`):
`profile.serializeContext(view.redacted, …)` over the caller's redacted view.

- **Entities pass `contextEntities`**: visible, not restricted, `ai:use` at the entity. An
  entity that fails is left out, not refused, so the AI never learns it exists. Masked columns
  are already masked.
- **With a focus**, the focused tables go in full (`selectedEntityIds`) and the rest as an
  outline (name and key columns), so a large project still fits. Without one, the whole
  visible model goes in, trimmed by the serializer's existing `tokenBudget` order.
- `includeDocs` follows `settings.ai.includeDocsInContext`, as for the assistant.
- **An empty project sends no `<schema>` block**, which is the Phase 5 behaviour today.

### 2.3 The instructions

`outputInstructions['draft-schema']` in each engine's `aiProfile` gains these rules:

- **Reuse what exists.** Reference existing tables by their real names and key columns; never
  re-create a table in `<schema>`. Add a column to an existing table with `ALTER TABLE … ADD
COLUMN` only when the description asks for it.
- **Relations are explicit:** foreign keys as named constraints, join tables for
  many-to-many, with `ON DELETE` chosen deliberately.
- **Follow the project's conventions** visible in `<schema>`: naming case, key type (`uuid`
  vs `bigint`), timestamp columns.
- **On revise:** change only what the instruction asks; return the whole revised draft.
- A one-line `COMMENT ON` per new table, so the docs importer (Phase 12 §5) documents them.

### 2.4 Checks, unchanged

`draftSchema` keeps its order:

1. The view (404 when invisible).
2. `ai:use` at the project, then the AI switch.
3. `assertConfigured` (503 `ai_not_configured`).
4. The rate limit.

The new context adds the per-entity filter of §2.2 and nothing else. Every write still needs
the import's own permissions at Import time.

## 3. Changes by place

- **`apps/api/src/ai`:**
  - The DTO's two optional fields.
  - `draftSchema` builds the context (§2.2), adds the revise turn, and runs the preview for
    `summary`.
  - About 60 lines, mostly reuse.
- **Engines:** the extra rules in `outputInstructions['draft-schema']` for PostgreSQL, MySQL
  and SQLite. The `aiProfile` conformance checks still apply.
- **Web:**
  - `canvas-surface.tsx`: **Describe with AI** in the toolbar and menus, and the
    selection entry.
  - `DescribeSchema`: the Build on line, the summary, Show SQL, Refine and Undo.
  - **Propose as a change**, which uses the existing change request create, then imports
    into the draft.
  - `create-project.tsx`: the fifth card and its flow. It reuses the `createdId` retry logic,
    so a retry doesn't create a second project.
- **No new route, table or migration.**

## 4. Tests

- **Context:**
  - the prompt contains the visible tables;
  - masked columns, restricted tables and tables without `ai:use` never appear;
  - an empty project sends no `<schema>`.
- **Focus:** focused tables in full, the rest as an outline; a focus id the caller can't see
  is dropped silently, and the same happens for an id that doesn't exist.
- **Revise:** the draft and instruction reach the provider; the response replaces the draft.
- **Summary:** built from the importer's preview, not the AI's text. An AI answer that
  re-creates an existing table shows it under "already exists".
- **Limits:** oversize `draft`, `instruction` or `focusEntityIds` gives 400.
- **e2e** against the fake Anthropic server (as workflow 3 does for the assistant):
  - describe a feature on a project with tables;
  - check the request carried the schema;
  - refine once;
  - import, and check the new foreign key points at the existing table.

## 5. Build order

1. Web: **Describe with AI** in the toolbar and menus (§1.1). No API change, so it can ship
   first, on its own.
2. API: context, `focusEntityIds`, `revise`, `summary`. Unit tests.
3. Engine instructions, with a spec per engine that the rules are present.
4. Web: Describe box changes (§1.1 steps 1–3).
5. Web: **Propose as a change** (§1.1 step 4).
6. Web: the projects-page card (§1.2).
7. e2e, roadmap row, and a line in the user docs.

## 6. Out of scope

- **A live canvas preview** of the draft before import. **Propose as a change** gives a real
  canvas today; a ghost-table overlay is a later row if users ask.
- **Changing or dropping existing tables** from a description. The import is additive
  (CLAUDE.md); a description that asks for it gets a warning in `summary`.
- **Sample data.** SchemaLoom models schemas, not rows.
- **A chat thread for schema design.** The assistant already has threads; this stays a
  focused draft-and-refine box. Stateless revise covers the back-and-forth.

## 7. Cost and limits

Each Draft or Refine is one AI request, counted by the existing per-user rate limit, the same
as an assistant message. The schema context makes requests larger for big projects; the
serializer's `tokenBudget` caps it, and the focus keeps it small.

## 8. Relation to Phase 21

An agent connected over MCP (row 21) uses its _own_ model to design schema and proposes it
with `propose_change` (§9 of that doc). This phase is for people inside SchemaLoom using the
server's AI. They share the import path, the change requests and the redacted context, but not
code paths: neither depends on the other.

## 9. Open questions

| #   | Question                                                        | Default                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Send the whole project, or only the selection?                  | **Selection in full, the rest in outline** (§2.2). Without the outline the AI re-creates tables it can't see                                                                                                 |
| Q2  | Store refinement history server-side?                           | **No.** Stateless revise keeps the user's edits and needs no table. Undo is one step, client-side                                                                                                            |
| Q3  | On the projects page, create the project before drafting?       | **Yes.** The route is project-scoped (engine, permissions, rate limit). An abandoned draft leaves an empty project the user can delete                                                                       |
| Q4  | Allow `ALTER TABLE … ADD COLUMN` on existing tables?            | **Yes, when asked.** It's additive. Build step 1 checks that the import's merge applies it to an existing table; if not, that's a small fix in the merge, not here. Renames, type changes and drops stay out |
| Q5  | Show **Propose as a change** to users who can import directly?  | **Yes**, as the second button. Reviewing on a canvas helps anyone, and it's the only option for users who can propose but not edit                                                                           |
| Q6  | Let the user choose conventions (naming, key type) in the form? | **No.** The AI follows what `<schema>` shows; on an empty project the engine's defaults apply. The user can say "use uuid keys" in the description                                                           |
