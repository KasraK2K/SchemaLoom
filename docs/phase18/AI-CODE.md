# Phase 18: the AI writes ORM code

Status: **approved 2026-10-04** with every default in the open-questions table. New roadmap row 18. Needs row 8's ORM layer (`docs/phase8/DESIGN.md`), because the model code comes from
it.

Decided with the owner before writing (2026-10-04): **both kinds of code**. Model code (the
Prisma, Drizzle, TypeORM or Django definitions) comes from the exporters, so it is exact and
redacted. The AI's new job is **query and usage code** in the chosen ORM.

## 1. What the user sees

The AI tab's mode switch gains **Code**, beside Ask and Explain. Code mode adds an ORM picker
(only the ORMs the project's engine exports; the last choice is remembered per user) and two
panes:

- **Models.** The selected tables' model code in that ORM, shown at once with a copy button.
  No AI call: it's the exporter's output for the selection (§2.1). It updates when the
  selection or the ORM changes.
- **The conversation.** "Orders over $100 this month with their customer's email" comes back as
  a Drizzle query (or Prisma Client, TypeORM QueryBuilder, Django QuerySet) that uses the names
  in the Models pane, plus the same query as SQL under a "Show SQL" fold, the assumptions, and
  the tables used glowing on the canvas, as in Ask mode. Asking for "a repository for orders"
  or "a seed script" works the same way: it's code in that ORM, over those models.

Everything else is unchanged: the same threads, rate limits, `ai:use` checks, kill switch and
"tables used" highlighting.

## 2. How it works

### 2.1 Models: the exporter, not the AI

`POST /projects/:id/orm-code` with `{ orm, entityIds }` → `{ text, incomplete }`.

- Marker `@RequirePermission('export:run', { project: 'projectId' })`, like the Export menu.
  It's an export, so it needs the export atom and not `ai:use`.
- The model goes through `VisibilityFilter` first (the branded `RedactedModel`), then is cut to
  the selected entities **plus the tables they reference by a visible foreign key**, so the
  output compiles (a Prisma relation needs both sides). Those extra tables are marked with a
  comment ("included because orders refers to it").
- An entity id the caller can't see is treated as absent (invisible is 404, never 403; here it
  simply isn't in the output, so the route is no existence oracle).
- The ORM layer gets one helper, `subsetModel(model, entityIds)`. Nothing else new.

### 2.2 Query code: one more AI mode

- `AiMode` gains `'code'`. The message route's DTO accepts `mode: 'code'` with
  `orm: OrmId`, validated against the engine's `exportFormats`.
- **Context** is what Ask mode sends (`aiProfile.serializeContext` over the redacted model)
  plus the Models pane's text for the same selection, so the AI writes against real class and
  field names. Both are deterministic, so both are in the cached prompt prefix.
- **Output** is tagged blocks, like Ask: `<code>` (the ORM code), `<query>` (the same query in
  the engine's SQL), `<explanation>`, `<assumptions>`. The ORM-specific instructions (which
  query API, which imports) are core's, keyed by `OrmId`, because they're the same for every
  engine. The engine's prompt still supplies the database nouns.
- **L25 holds without change.** The `<query>` twin goes through the engine's `QueryValidator`
  (no probe, L13) exactly like Ask mode, and the stored message's touched ids are the
  validator's ids **plus the context's entity ids**, which `ai.service` already adds for every
  answer. A missing or invalid `<query>` therefore never under-records: the context ids cover
  everything the AI was shown. The validation result is shown ("the SQL equivalent references
  `orders.totl`, which doesn't exist") as in Ask mode.
- ORM code itself is **not executed or type-checked** on the server. Running user-adjacent code
  is not something the api does.

### 2.3 Web

- Mode switch: Ask · Explain · **Code**. The ORM picker appears in Code mode.
- The Models pane calls `orm-code` (debounced on selection changes) and renders the text in the
  existing read-only code view with the ORM's language for highlighting (TypeScript, Prisma,
  Python).
- The answer renders `<code>` in the same code view, with copy; `<query>` in the SQL editor
  under "Show SQL", where "Save query" still works.

## 3. Tests

- **api:** `orm-code` route spec (marker; redaction; a hidden entity id simply absent; FK
  neighbours included). AI service spec: `mode: 'code'` validates the `<query>` twin and stores
  validator ids ∪ context ids; a missing `<query>` still stores the context ids; an ORM the
  engine doesn't export is a 400.
- **ai-profile:** each engine's `outputInstructions.code` names the four tags;
  `parseAiOutput` maps them (`code`, `query`, `explanation`, `assumptions`).
- **e2e:** workflow 3 (AI) gains one Code-mode step with the provider mocked, as it is today.

## 4. Open questions

| #   | Question                                           | Default                                                                                                                |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Q1  | Models pane: selection only, or the whole project? | **Selection plus referenced tables**, so it compiles; an empty selection means the whole visible model, as in Ask mode |
| Q2  | Who may open the Models pane?                      | **`export:run`**: it is an export. A user with `ai:use` but no export right sees the conversation pane only            |
| Q3  | Execute or type-check generated ORM code?          | **No.** The SQL twin is validated; the ORM code is shown, not run                                                      |
| Q4  | Remember the ORM choice                            | **Per user, in the browser** (`localStorage`). Not worth a server column                                               |
| Q5  | Rate limits                                        | **Shared with Ask/Explain** (30/user/h, 300/org/h). The Models pane makes no AI call and is not rate-limited           |
