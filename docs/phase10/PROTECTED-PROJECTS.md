# Phase 10b: Protected projects (schema changes only through change requests)

Status: **built 2026-10-01** (approved the same day with every default in §7). Roadmap row 10b.

**As built**, with these adjustments:

- **Its own route**, `PATCH /projects/:projectId/require-change-requests` with
  `{ enabled }`, like `restricted-field-mode`, rather than a key on `PATCH …/settings`: the
  value is a real column, and the settings route patches the JSON `settings` blob. `GET
…/settings` and `GET /projects/:projectId` return `requireChangeRequests`.
- **The canvas is not put in share-link `readOnly` mode**, because that mode also stops
  dragging and auto-layout, which §1 keeps. A protected project hides the schema actions
  instead (add table, Import SQL, Sync, connecting tables, deleting links), and the header
  shows a **Protected** chip next to **Propose a change**. The inspector's edit controls
  stay visible; an edit there gets the protected sentence from the 423. Hiding them too
  can come with a general "can I edit?" signal in the inspector.
- **The area-editors note** in the settings checkbox is always shown, rather than only when
  the project has area-scoped editors.
- A **queued** import or Sync job on a protected project fails in the job with the same
  423; the controls that start one are hidden, so this is only reachable through the API.

Phase 10 left this out on purpose (`DESIGN.md` Q4: "Requests are opt-in; direct editing
keeps working"). In practice that made the easy mistake the common one: people edit the
project, then wonder why their change request is empty, and anyone with edit access can
change the schema with no review at all. This adds a per-project switch that makes change
requests the only way in, like branch protection on a Git repository.

## 1. What the user sees

1. **Project settings → Require change requests**, a checkbox that people who manage
   sharing can turn on or off. Turning it on says what it does: "Schema changes to this
   project will only be possible by merging a change request."
2. **On a protected project, the canvas is read-only for everyone**, with a banner:
   "This project is protected. Propose a change to edit it." and a **Propose a change**
   button. The draft opens as today, fully editable for its author.
3. **What stays possible on the protected project:** comments, docs, moving tables on the
   canvas (layout), exports, history, drift checks, saved queries, the AI assistant's
   answers, and merging an approved change request.
4. **What is refused:** every schema edit from the canvas, the inspector or the AI's
   suggested edits, SQL import, **Sync** from a database, and **Restore** from History.
   Each one shows the same sentence, with a link to propose a change instead.
5. A small **Protected** badge next to the project name, so people know before they try.

## 2. One check, in `SchemaWriter`

Every schema write goes through `SchemaWriter.apply` (CLAUDE.md: "there is no second
mutation path"), so one check there covers every writer, including ones added later. Today's
callers:

| Caller                                          | What it is                        | On a protected project              |
| ----------------------------------------------- | --------------------------------- | ----------------------------------- |
| `SchemaController.ops` (`POST …/schema/ops`)    | canvas, inspector, AI suggestions | refused                             |
| `SnapshotsService.importSource` (import job)    | SQL import, Sync from a database  | refused                             |
| `SnapshotsService.restore`                      | Restore from History              | refused (Q3)                        |
| `ChangeRequestsService.merge`                   | merging a request into main       | **allowed**: it is the way in       |
| `ChangeRequestsService` fork / Update from main | writes the **draft**              | allowed: a draft is never protected |

- `WriteContext` gains `origin: 'edit' | 'import' | 'restore' | 'merge' | 'draft'`, set by
  each caller. It is required, so a new caller has to choose, and the compiler shows every
  call site that needs one.
- Inside the transaction, next to `EngineGate.checkWrite` (which already reads the project
  row there), `SchemaWriter` refuses when the project is protected and `origin` is not
  `merge` or `draft`.
- The refusal is **423 `project_protected`**. 423 already means "this project can't be
  written right now" (engine read-only, doc 03 §15). The web client's 423 message is
  currently the engine one for every 423, so it has to tell the two apart by `code`.
- **Layout is not schema.** `GeometryWriter` is not gated. A merge never carries layout
  moves for existing tables (Phase 10 Q5), so gating it would freeze a protected project's
  layout for good.
- The check reads the column inside the write transaction, so turning protection on takes
  effect for the next write. A batch already running finishes.

## 3. Data

```prisma
model Project {
  // …
  /// Phase 10b: schema writes only through a change-request merge (SchemaWriter).
  requireChangeRequests Boolean @default(false) @map("require_change_requests")
}
```

- A real column, not a key in `settings`, because `SchemaWriter` reads it on every write, the
  same reasoning as `restrictedFieldMode`.
- **Set through the existing `PATCH /projects/:projectId/settings`** (`sharing:manage`), as
  `{ requireChangeRequests: boolean }`. `GET …/settings` returns it.
- A draft project can't be protected: the route answers 404 for a draft, as the other
  settings routes do.
- Every change writes `project.protection_changed` to `AuditLog`, with the new value.
- `ProjectDetail` (`GET /projects/:projectId`) gains `requireChangeRequests: boolean`, which
  is all the canvas needs for the banner and read-only mode.

## 4. Who is affected

- **Editors and org owners alike.** There is no bypass (Q2). A manager who really needs a
  direct edit turns protection off, edits, and turns it back on. Both switches are in the
  audit log.
- **Area-scoped editors lose direct editing and can't propose either**, because a change
  request needs a complete view of the project (Phase 10 §3, Q2). On a protected project
  they can comment and edit docs. The settings checkbox says so when the project has any
  area-scoped editors.
- **API tokens** (roadmap 11) have no write scope, so nothing changes for them.
- **The engine-upgrade CLI** writes props directly as an operator, not through
  `SchemaWriter`. It is unaffected, which is right: it changes no schema.

## 5. Web

- `ProjectSettingsDialog`: the **Require change requests** checkbox, managers only, next to
  the AI switches.
- Canvas: when `requireChangeRequests` is true and the project isn't a draft, the canvas
  opens with the existing `readOnly` mode (built for share-link visitors), plus the banner
  from §1. Presence stays on, unlike share-link visitors.
- Import dialog, **Sync**, and History's **Restore**: hidden on a protected project, with
  the banner's sentence in their place, rather than shown and refused.
- `toApiError`: a 423 with code `project_protected` gets "This project is protected:
  propose a change to edit it." Every other 423 keeps the engine message.

## 6. Build order

1. Migration for the column; `GET/PATCH …/settings` and `ProjectDetail`; audit entry.
2. `WriteContext.origin` at every call site, and the check in `SchemaWriter`, with unit
   tests: each origin on a protected and an unprotected project, and a draft that can't be
   protected.
3. Web: the settings checkbox, the read-only canvas and banner, hiding Import, Sync and
   Restore, and the 423 message.
4. e2e, added to workflow 11:
   - protect the project;
   - a direct edit, an import and a restore are refused with 423;
   - layout and comments still work;
   - a proposed, approved request merges;
   - turn protection off and a direct edit works again.

## 7. Open questions

| #   | Question                                                             | Default                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Per project, or one switch for the whole organisation?               | **Per project.** Teams protect production-like projects and keep scratch ones open. An org default can come later                                                                                                   |
| Q2  | Can org owners or managers bypass protection?                        | **No.** Turning it off is the bypass, and it is audited. A silent bypass is the hole people use                                                                                                                     |
| Q3  | Restore from History on a protected project?                         | **Refused.** A restore is a big unreviewed write. Turn protection off to restore, or propose the old state as a request                                                                                             |
| Q4  | **Sync** from the saved connection on a protected project?           | **Later: "Sync into a new change request"**, which forks a draft and imports there. In v1 Sync is hidden. Saved connections aren't copied to drafts (Phase 10 §2), so the draft's import dialog takes typed details |
| Q5  | Must a merge on a protected project have more than one approval?     | **No**, one current approval, as today. A required-approvals count can come later                                                                                                                                   |
| Q6  | Layout (moving tables) on a protected project?                       | **Allowed.** Layout is not schema and merges don't carry it (Phase 10 Q5)                                                                                                                                           |
| Q7  | Should area-scoped editors be able to propose on protected projects? | **Not in this row.** It needs area-scoped drafts (Phase 10 Q2). Until then, protection takes their direct editing away                                                                                              |
