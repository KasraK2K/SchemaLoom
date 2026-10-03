# Phase 10c: Propose first, name it on submit; protected means locked

Status: **built** 2026-10-03 (approved the same day: the owner chose Q1–Q4 below; the rest
are defaults). Roadmap row 10c.

**As built:**

- The **Submit changes** dialog asks for a title and a description. Reviewers stay
  API-only (`reviewerIds` on submit), as they were on the old propose dialog.
- The canvas and inspector stay read-only until the project shell has loaded, so the
  canvas's first auto-placement can't fire on a protected project before the flag is known.
- The request page counts what a merge would carry: non-cosmetic entries plus the moves.
  A table both sides moved (main's wins) is cosmetic there and not counted.
- Covered by `layout-moves.spec.ts`, the `draftMap` and `GeometryWriter` specs, and e2e
  workflow 11 (the browser flow, a refused move, private drafts, a merge that moves a table).
  Amends `DESIGN.md` (Phase 10) §1 and Q5, and `PROTECTED-PROJECTS.md` (10b) §1, §5
  and Q6.

The owner's complaint, 2026-10-03: on a protected project people can still move tables and
the inspector still offers edits (refused by the api afterwards), and **Propose a change**
asks for a title before anyone has changed anything. What they want:

> When a project is protected no one can edit it, not even move tables or connect columns.
> An editor clicks **Propose a change**, makes their changes, clicks **Submit changes**, and
> only then gives the change a name and a description.

## 1. What the user sees

1. **A protected project is read-only on the canvas and in the inspector**, for everyone,
   owners included: no dragging, no auto-layout, no connecting columns, no add or delete, and
   the inspector shows details instead of edit controls. Comments and the Docs panel still
   work (Q2): they describe the schema, they don't change it.
2. **Propose a change** (every project, Q3) opens a draft at once, with no dialog. If the
   person already has an unsubmitted draft of this project, the button reads **Continue your
   draft** and opens that one instead (Q4).
3. The draft's banner says "Your draft of _project_ · not submitted yet" with **Submit
   changes**, **Discard** and **Back to project**.
4. **Submit changes** asks for a title (required) and a description (optional), then opens
   the change request page. From then on the draft banner is today's
   ("Draft for change request _title_ · View request · Back to project"), and the author can
   keep editing; an edit makes earlier approvals stale, as today.
5. Moving tables in the draft is part of the change (Q1). The request page counts them
   ("3 tables moved"), the review diff lists them as layout changes, and a merge applies
   them. A request that only moves tables can be merged.

## 2. The unsubmitted request

`ChangeRequestStatus` gains **`draft`**: forked, not yet submitted.

- **One per author per project**: a partial unique index on `(project_id, author_id) WHERE
status = 'draft'`. Creating a second returns the first.
- **Private to its author.** Lists leave it out for everyone else, `GET /change-requests/:id`
  is a 404 for them, and the draft project's map is empty for anyone but the author (the
  resolver's draft rule). Nobody is notified.
- **Writable by its author**, like an open request: `draftOpen` covers `draft` and `open`.
  **Update from main** works on it. Reviews, merge, close and reopen don't (`not_submitted`).
- **Discard** is the existing delete (unmerged and unreviewed, which a draft always is).
- **Submit** flips `draft` → `open` (conditionally, so a double click submits once), sets
  title, description and reviewers, renames the draft project to `<project>: <title>`, and
  notifies the reviewers, which is what create does today. `createdAt` stays the fork time.

## 3. API

| Route                                       | Change                                                                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /projects/:projectId/change-requests` | Body optional. **No title**: return the caller's `draft` request, or fork one. **With a title**: today's behaviour (fork and open at once). |
| `POST /change-requests/:id/submit`          | New, `@Authenticated`. `{ title, description?, reviewerIds? }`. Author only; 409 `change_request_not_draft` unless the status is `draft`.   |
| `GET /projects/:projectId/change-requests`  | Leaves out other people's `draft` requests, so a `draft` in the list is the caller's own: that drives **Continue your draft**.              |

Keeping the titled create means API clients and e2e workflow 11 are unaffected.

## 4. Protection covers layout

- `GeometryWriter` runs the same `assertUnprotected` as `SchemaWriter`: a protected project
  answers 423 `project_protected` to a move, unless the write is a merge's.
- **Merge carries layout** (Q1, reverses Phase 10 Q5). After the schema batch, the merge
  moves every existing table whose position the draft changed since the base, through
  `GeometryWriter` with origin `merge`, so open canvases see it live. Where the main project
  also moved that table since the base (only possible on an unprotected project), main's
  position wins: layout is never a conflict.
- `no_changes` now means no schema change **and** no move. A moves-only merge writes no
  schema batch; the status flip and the "Before merging" snapshot run in their own
  transaction, then the moves.
- `threeWay` is unchanged: layout stays out of conflicts. The moves are computed next to it.

## 5. Web

- Canvas: a protected project is `readOnly`, the same mode share-link visitors get (no drag,
  no auto-layout, no connect, no toolbar), with the empty-canvas sentence kept.
- Inspector: on a protected project the entity, field and link tabs show the read-only
  details instead of the editors.
- Header: **Propose a change** / **Continue your draft** with no dialog; the draft banner
  of §1.3 with the **Submit changes** dialog (title, description, reviewers) and **Discard**
  (with a confirm).
- Changes tab: the caller's own unsubmitted draft, if any, is listed first as "Not
  submitted"; the request page for it says so and offers Submit and Discard.

## 6. Build order

1. Migrations (enum value, then the partial index: Postgres can't use a new enum value in the
   transaction that adds it). Resolver rule. Service: create without a title, submit, list
   and read filters, `not_submitted`. Unit and route tests.
2. `GeometryWriter` protection and the merge's layout moves, with tests (protected move
   refused, merge moves applied, main's move wins, moves-only merge).
3. Web: read-only protected canvas and inspector, the propose button, the draft banner with
   Submit and Discard, the Changes tab entry.
4. e2e: workflow 11 gains the propose → edit → submit flow on a protected project, a refused
   move, and a merge that moves a table.

## 7. Open questions

| #   | Question                                                                     | Decision                                                                                              |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Q1  | How does layout change on a protected project?                               | **Owner: the merge carries the draft's moves.** Reverses Phase 10 Q5                                  |
| Q2  | Docs and comments on a protected project?                                    | **Owner: both stay.** Docs aren't copied into drafts (Phase 10 Q6), so locking them would freeze them |
| Q3  | Propose first, name on submit: protected projects only?                      | **Owner: every project.** Unprotected projects can still be edited directly                           |
| Q4  | Propose again while an unsubmitted draft exists?                             | **Owner: resume it.** One unsubmitted draft per person per project; Discard to start over             |
| Q5  | Do unsubmitted drafts expire?                                                | **No.** They are the author's work; Discard removes one. Revisit if they pile up                      |
| Q6  | Can a submitted request go back to unsubmitted?                              | **No.** Close it, or delete it while unreviewed                                                       |
| Q7  | Should the empty draft be refused on submit?                                 | **No.** The request page already says "no changes yet", and Merge is blocked by `no_changes`          |
| Q8  | Owner or admin bypass for layout on a protected project, like a "tidy" tool? | **No**, as 10b Q2: turning protection off is the bypass, and it is audited                            |
