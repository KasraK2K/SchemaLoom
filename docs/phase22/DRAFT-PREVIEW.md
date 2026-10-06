# Phase 22b: preview an AI draft on the canvas

Status: **built** 2026-10-06. Approved with the §6 defaults the same day (Q2 included, since
Phase 23 is built). Roadmap row 22b. Builds on `DESIGN.md` (Describe with AI) and, for cards,
Phase 23.

As built, where it differs from or adds to the text below:

- **Placement** is ELK over the ghosts alone; the block then goes to the right of its anchor
  (the focus, else the tables it links to, else everything) and steps right past any table or
  card it would overlap. Not one ELK run with the existing tables pinned: layered has no pinned
  nodes. Ghosts have fixed pixel sizes, so nothing waits on a measurement.
- **The area (Q2)** comes from the AI: `DRAFT_SCHEMA_RULES` asks for one `-- area: <name>` line
  when the description is one module, and the server reads it into `preview.area`. Import
  creates the area, or joins an existing one of the same name.
- **Import from the panel skips the rename question.** The AI is told never to rename, so a
  candidate there is a lookalike (`orders` → `invoices`), and "Keep both" was the default.
  SQL import keeps the question.
- **`ALTER TABLE … ADD COLUMN`** is now read by the PostgreSQL importer. The Phase 22 rules
  already asked the AI to add columns that way, but the importer dropped the statement, so
  "new columns on an existing table" never reached the summary or the import.
- **A ghost's line to an existing table** is drawn from that table's right side, since ghosts
  sit to its right; the line carries no direction.
- Hovering a ghost, or the faded rows under an existing table, lights
  its name in the summary, and the reverse. Ghost lines and ghosts have no context menu.

Today a draft is read as a summary ("Adds 4 tables, 2 relations…") with SQL behind **Show
SQL**, inside a dialog that covers the canvas. People want to see the shape first: where the
new tables sit and what they connect to, before anything is written.

## 0. The decisions

| #   | Question              | Decision                                                                                                                                  |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Where the draft shows | **On the real canvas, as ghost tables**: dashed outline, faded, not editable. Existing tables stay normal.                                |
| D2  | Where the box lives   | **A docked side panel** while on the canvas, so the canvas stays visible. The projects page keeps its dialog (no canvas there).           |
| D3  | What the api returns  | **A small preview shape next to the SQL**: new tables with columns, new columns on existing tables, and relations. No new route.          |
| D4  | Where ghosts go       | **Laid out once** with ELK in free space beside the focused tables (or to the right of everything). Import puts the tables exactly there. |
| D5  | What is written       | **Nothing until Import**, as today. A preview is web state only.                                                                          |

## 1. What the user sees

- **Describe with AI** opens a panel on the right. After **Draft**, ghost tables appear on the
  canvas and the view pans to frame them. Dashed lines join them to the existing tables they
  reference.
- **New columns on an existing table** show as faded rows at the bottom of that table, marked
  `+`.
- **Hovering a ghost** highlights its line in the panel's summary, and the reverse.
- **Refine** replaces the ghosts with the new draft. **Undo** brings the previous ghosts back.
  **Discard** clears them.
- **Import** writes the draft, and the tables land where their ghosts were. **Propose as a
  change** works as today, and the change request's draft project gets the same positions.
- If the draft groups tables (a description such as "a billing module"), the ghosts are inside a
  ghost card (Phase 23), and Import creates the area (Q2).
- Ghosts can't be dragged, edited or connected. Changing the draft is what Refine is for.

## 2. API

`POST /projects/:projectId/ai/draft-schema` (unchanged route and checks) adds `preview` to its
answer:

```ts
interface DraftPreview {
  tables: { key: string; name: string; columns: { name: string; type: string; pk: boolean }[] }[];
  addedColumns: { entityId: Id; columns: { name: string; type: string }[] }[];
  links: { from: string | Id; to: string | Id }[]; // draft `key` or existing entity id
}
```

- It's built from the model the server already imports for `draftSummary`, against
  `view.redacted`. An existing table appears only by an id the caller can already see; a draft
  can't reference anything else, since the AI only saw the redacted context.
- Types are the engine's display names (`TYPE_CATALOG.format`), so ghosts read like real tables.

## 3. Web

- **Panel:** `describe-schema.tsx`'s `DraftReview` moves into a `DescribePanel` docked beside
  `CanvasSurface`. `import-dialog.tsx` keeps SQL import only, and links to the panel.
- **Ghost nodes:** a `ghost` node type and a `ghostLink` edge type in `canvas-surface.tsx`,
  drawn from `DraftPreview` with the theme's card styles at 55% opacity and dashed borders
  (each theme in `themes.css` sets `--ghost-*`). Faded rows on existing tables go through
  `EntityNodeData` as `pendingColumns`.
- **Placement:** one ELK run over the ghosts plus the existing tables they link to, with those
  existing tables fixed. The results are snapped to the grid and kept with the draft.
- **Import:** after the import job completes, one geometry batch sets each new table's
  position by name, replacing today's `unstack()` pile for this path.
- **Protected projects:** the preview works; **Import** is hidden and **Propose as a change**
  is offered, as today.

## 4. Tests

- Unit: `DraftPreview` from a model (a link to an existing table carries its id; a hidden table
  never appears); ghost placement keeps existing tables fixed and doesn't overlap them.
- Api: the answer has `preview` and the existing fields are unchanged.
- E2E (workflow 21, with the fake AI): draft, see ghost tables and a dashed link on the canvas,
  refine, see them replaced, import, and check that the tables sit at the ghosts' positions.

## 5. Out of scope

- Editing a ghost directly (rename a column on the canvas). That's Refine's job, and editing
  would make the preview a second editor.
- Previewing SQL import or Prisma import the same way. Possible later on the same ghost
  nodes.
- Changes to existing tables beyond added columns, since the import is additive (CLAUDE.md).

## 6. Open questions (defaults are the recommendation)

| #   | Question                                 | Default                                                                                                          |
| --- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Q1  | Panel or dialog on the canvas            | **Panel** (D2).                                                                                                  |
| Q2  | Let the AI suggest a card for its tables | **Yes, once Phase 23 is built**: the draft may carry one area name, shown as a ghost card. Before that, no card. |
| Q3  | Keep ghosts after closing the panel      | **No.** Closing discards the preview; reopening shows the last draft again until the page is left.               |
