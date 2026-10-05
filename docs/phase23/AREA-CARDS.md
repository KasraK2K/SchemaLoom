# Phase 23: area cards on the canvas

Status: **built 2026-10-05**, with every default in §6 approved (UI label: "area"). What
differs from this design is in §7, "As built". Roadmap row 23. Builds on areas (doc 04 §2.11,
doc 05 §7.11) and the canvas (`apps/web/src/features/canvas`).

Some tables belong together (`books`, `book_shelves`, `authors`). The user puts them in a
coloured card, and auto layout keeps them inside it.

**Cards are areas.** SchemaLoom already has areas: a name, a colour, an order, a doc, and
`Entity.areaId` (one area per table). Today they show only as a tinted card header, and no
screen creates one. This row draws them and makes them easy to use. It adds no new concept
and no migration.

## 0. The decisions

| #   | Question               | Decision                                                                                                                                             |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | New concept or areas?  | **Areas.** One grouping, already shared, exported and filtered by area. A second, visual-only grouping would confuse "Share an area".                |
| D2  | Card size and position | **Derived** from its tables (bounding box plus padding), as decided in Phase 1 Q4. No stored rectangle; a card can't drift away from its tables.     |
| D3  | Joining a card         | **An explicit gesture**: group the selection, drop a table on a card, or pick the area in the inspector. Never by where a table happens to sit (C5). |
| D4  | Auto layout            | **Each card is laid out as a unit.** ELK compound nodes: a card's tables stay inside it, and cards are placed like big tables.                       |
| D5  | Style                  | **Quiet**: a light tint, a thin border in the area colour, the theme's corner radius, and a small name label. Each appearance theme sets its own.    |

## 1. What the user sees

- **Create:** select tables, then **Group into card** (toolbar, right-click, `Ctrl/Cmd+G`).
  The name field gets focus ("Card 1" until renamed). The next unused colour is picked.
- **The card** sits behind its tables, 32 px wider than them on every side, with the name at
  the top left. The name label's menu has **Rename**, **Colour** (8 swatches), **Ungroup**
  (keeps the tables, deletes the area) and **Share this card** (managers only, the existing
  area grant dialog).
- **Drag the card's label** and every table in it moves (one geometry batch, one undo step).
- **Add a table:** drag it onto a card; the card highlights while it's under the pointer, and
  dropping it joins. Or use **Area** in the table's inspector.
- **Remove a table:** **Remove from card** on the table's menu, or set **Area** to none.
  Dragging a member out only stretches the card (D2/D3: pixels never change membership).
- **Auto layout** keeps every card's tables together and inside it. Tables in no card are laid
  out around the cards.
- **Sidebar:** the existing area list gets a coloured dot per card. Clicking one selects and
  frames its tables.

A table in a card still shows its own colour override if it has one. Otherwise its header
uses the card colour, as today.

## 2. Access: a card is also a sharing scope

A grant on an area covers every table in it. So moving a table into a card can let more
people see it, and moving it out can let fewer people see it.

- **Same permission as today:** creating areas and moving tables between them is
  `schema:edit` (doc 05 §2), through `SchemaWriter`. It already bumps `permGeneration`
  (`changesSkeleton`). Nothing new on the server.
- **Say it before it happens:** when the source or target area has its own grants, the web
  asks first: "Billing is shared with 3 people. They will see `invoices` too." Users who can't
  see the grants (no `sharing:manage`) get no dialog, which matches what they could do today
  through the inspector.
- **Partial viewers:** a card is drawn from the tables the viewer can see. A card whose
  tables are all hidden isn't drawn. The area itself comes through `VisibilityFilter`, as now.
- **Protected projects:** grouping is a schema change, so it is offered only inside a change
  request (Phase 10c). Merges carry it.

## 3. How it is built

- **Canvas** (`canvas-surface.tsx`, `graph.ts`): a second node type, `area`, rendered at
  `zIndex: -1`, not selectable as a table and not connectable. Its rectangle is computed from
  its members' measured sizes on every render. The drop target is a hit test of the dragged
  table's centre against the area rectangles.
- **Colour** (`area-color.ts`): use the stored `Area.color` instead of the round-robin. The 8
  swatches are the 8 existing `--color-area-N` tokens; the stored value is the token name
  (`area-3`). Old values ("indigo") map to their slot, and unknown values fall back to the
  round-robin. Each theme in `themes.css` adds `--color-area-N-border` (Blueprint, whose
  tints are transparent, uses the border only).
- **Auto layout** (`layout.ts`): areas with members become ELK parent nodes with their tables
  as children, `elk.hierarchyHandling: INCLUDE_CHILDREN` and 32 px padding. Positions come
  back relative to the parent and are made absolute before `applyPositions`. The card has no
  stored geometry, so nothing else changes.
- **Writes:** **Group** is one ops batch: `create area` plus `update entity { areaId }` per
  table. **Ungroup** is `update entity { areaId: null }` per table plus `delete area`. Both are
  one undo step.
- **Realtime:** area ops already broadcast; other viewers' cards redraw from the model.

## 4. Tests

- Unit: the rectangle from member boxes; the drop hit test; the colour mapping (old Radix
  names, token names, unknown values); the layout keeps every member inside its parent and
  makes positions absolute.
- Api: a group batch bumps `permGeneration` once; a protected project refuses it (423)
  outside a merge.
- E2E (a new workflow): group three tables, rename and recolour the card, auto layout, and
  check every member's box is inside the card's. Drag a table onto it and see it join;
  remove it from the card.

## 5. Out of scope

- **A table in two cards.** `Entity.areaId` is one id, and areas are permission scopes;
  overlapping scopes would need a new access rule.
- **Cards inside cards.**
- **Collapsing a card** to a single block. Per-viewer collapse is already noted in the
  schema; it is a later row.
- **Free-drawn cards** with a stored rectangle (Phase 1 Q4 kept them out; adding them is
  additive later).

## 6. Open questions (defaults are the recommendation)

| #   | Question                                   | Default                                                                                                                |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Q1  | Call them "cards" or "areas" in the UI?    | **Areas** everywhere, because sharing and export already say "area". The menu item is **Group into area**.             |
| Q2  | Confirm before a move that changes access? | **Yes**, only when an affected area has its own grants and the user can see them.                                      |
| Q3  | Drag a member out to remove it?            | **No** (D3). Use the menu or the inspector. Revisit if users keep trying.                                              |
| Q4  | Empty cards                                | **Not drawn.** Ungrouping the last table deletes the area; an empty area stays in the sidebar only if a grant uses it. |

## 7. As built

Built as designed except for the points below. Tests are the ones in §4, plus a unit test for
the access sentences (`area-access.spec.ts`) and for the write batches (`area-ops.spec.ts`).

**Where the design assumed something that was not there**

- **No sidebar area list existed**, and neither did an **Area field in the inspector** (§1
  says "the existing area list" and "Area in the table's inspector"). Both are new, and small:
  - the list is a panel under the canvas search, one row per area that has a visible table
    (coloured dot and name; click selects its tables and frames them). It is not in the app
    sidebar, which only holds org navigation;
  - the inspector has an **Area** select (None plus the project's areas). It is hidden when
    the project has no areas and the table is in none.
- **"Share this card" reuses `WhoHasAccessDialog`**, which had no way to open on a chosen
  resource. It now takes `open`, `onOpenChange` and `initialScopeId`, and `trigger={null}`
  for "no button". The menu item reads **Share this area** and appears when `GET /access`
  says `canManage`.

**Choices the design left open**

- **Removing the last table does not delete the area (Q4).** Only the explicit **Ungroup**
  deletes it. A delete hard-deletes the area's grants, and for a viewer who sees only part of
  an area it would also null the `areaId` of tables they cannot see, so deleting as a side
  effect of "Remove from area" or setting **Area** to none is not safe. An empty area is not
  drawn and not listed on the canvas; it stays in the sharing tree.
- **One undo step means one batch.** Group, ungroup, add and remove are each one ops batch,
  so one revision in History. The canvas's own Ctrl/Cmd+Z only covers positions today (no
  schema write is undoable there), so those four cannot be undone from the keyboard. Dragging
  the label is one geometry batch and one Ctrl/Cmd+Z step, as designed.
- **Protected projects.** The canvas is read-only on a protected project (Phase 10c), so
  Group and the other gestures are not offered there. There is no change-request canvas to
  offer them in yet. Merges carry area ops, covered by an API test.
- **Dropping several selected tables** on a card joins all of them. The card is chosen by the
  centre of the table under the pointer, and a table's own card never counts as a drop target.
- **The access sentence** is built from `GET /access?explain=1` and shown only when
  `canManage` is true. If that request fails the move goes ahead without the dialog. It also
  covers **Ungroup** ("Ungrouping removes that sharing") and the inspector's Area field, which
  share one hook, `use-area-actions.tsx`. "People" are principals holding a grant on the area
  itself.
- **Colours.** New areas store `area-N`, the least used token first. Old Radix names are read
  as the token of that hue (`indigo` is `area-6`); anything else falls back to the round-robin
  by `ordinal`. Studio's border comes from `theme.css` (`--area-hue-N` mixed 45% into the
  canvas); Blueprint (85%), Float (35%) and Compact (65%) set their own in `themes.css`.
- **New area name** is "Area N" (first free number), with the name field focused and selected.
- **Shortcut:** Ctrl/Cmd+G. The toolbar button **Group into area** appears while a table is
  selected.

**Found while building**

- A card is derived, not state, so React Flow's measurement of it has nowhere to go. Without
  an explicit `measured` size on the card node, `useNodesInitialized` never turned true while a
  card was on the canvas and the first placement after an import never ran. Caught by the
  e2e; covered by a unit test.
- ELK lays the whole hierarchy out in one pass (`hierarchyHandling: INCLUDE_CHILDREN`), with
  the same 32 px padding the card draws, so a link between two cards still orders them.
