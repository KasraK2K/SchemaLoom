# Phase 10: Schema change requests

Status: **approved 2026-10-01** with every default in §10, and **built** the same day. Roadmap row 10.

**As built:** the base IR is stored on the request (`baseIr`), not as a snapshot, because
auto snapshots are pruned. Update from main is author-only, and closing keeps the draft
(read-only) instead of soft-deleting it. The review diff is redacted with the reviewer's
uniform map over a skeleton built from the model itself, so tables the draft deleted or
created still show. Covered by e2e workflow 11, including a conflict and the browser flow.

**Added 2026-10-01 (owner's request): Delete.** `DELETE /change-requests/:id` removes a
request and its draft for good, for the author or an editor of the project, only while it is
unmerged (a merged request is part of the project's history) and unreviewed (a review is
someone else's work, so close it instead). Otherwise 409 `change_request_merged` or
`change_request_reviewed`. Audited as `change_request.deleted`. Notifications that linked to
it now open a "does not exist" page. The request page also says plainly when the draft has
no changes yet, with a link to it, because editing the project instead of the draft is the
easy mistake.

**Amended 2026-10-03 by `PROPOSE-FIRST.md` (10c):** **Propose a change** opens the draft at
once and the title comes on **Submit changes**; until then the request is `draft`, private to
its author. A merge now carries the draft's table moves (Q5 reversed).

A change request is the pull request of a schema: someone proposes edits in a draft, others
review the diff and the migration SQL, and an editor merges it into the project. It sits on
top of what already exists: the canvas, SchemaWriter, history diffs, the migration generator,
comments and notifications.

## 1. What the user sees

1. On the canvas, **Propose a change** asks for a title (and an optional description and
   reviewers), then opens the **draft**: a full canvas with a banner saying
   "Draft for change request _Add invoices_ · View request · Back to project". Everything works
   as usual there: editing, comments, AI, docs panel, export.
2. The project gets a **Changes** tab next to History. It lists the change requests (open,
   merged, closed) with author, reviewers' verdicts, and "N changes".
3. The **change request page** shows the title, description, status and:
   - the diff from the starting point to the draft (the History diff view, reused),
   - the migration SQL for that diff (the Phase 5 generator, reused),
   - reviews: **Approve** or **Request changes**, each with an optional note,
   - **conflicts**, if the project changed the same objects since the draft started,
   - **Update from main**, **Merge**, **Close**. A disabled button says why.
4. After a merge, the project shows the changes, History has a "Before merging _Add invoices_"
   snapshot, and the author and reviewers get a notification.

## 2. The draft is a hidden project

The draft is a copy of the project in its own `Project` row, with `draftOfId` pointing at the
main project. That is the one decision everything else follows from:

- **It reuses the whole editor.** Canvas, SchemaWriter, realtime, comments and exports all
  work on any project, so none of them needs a draft mode. The rule "all schema writes go
  through SchemaWriter" still holds, because the draft is written like any other project.
- **Object ids are global primary keys**, so the copy cannot reuse the main project's ids.
  The fork gives every copied object a new id and stores `idMap` (draft id → main id) on the
  change request. Objects created in the draft have no entry; at merge they are created in
  the main project under fresh ids. (As first written, they kept the id they had, but the
  draft's own row still holds it, so every merge that added a table failed on the primary
  key. Fixed 2026-10-05, found by roadmap 21b's e2e.)
- **The fork** reads the main project's live IR, creates the draft row (same engine and
  engine version), and writes everything with `planImport` creates through SchemaWriter. It
  also stores the starting point as a snapshot of the main project (`baseIr`). If the
  fork fails partway, the draft row is deleted.
- **Hidden everywhere else.** Project lists, org counts, drift schedules, saved connections
  and search filter on `draftOfId IS NULL`. Grants, share links and connections are not
  copied. Deleting the main project cascades to its drafts. Closing or merging a request
  makes its draft read-only (as built: the draft is kept, so a closed request still shows
  its diff and reopening is a status flip).

## 3. Who can do what

To create, open or review a change request you need a **complete view of the main project**
(`isCompleteView`, the same check restore and migration SQL use today). The draft is a full
copy, so it cannot be handed to someone who can't see everything. Area-scoped users can't
propose changes in v1 (Q2).

The draft's permission map is not stored anywhere. The resolver works it out from the main
project:

| Subject                                  | Map on the draft                                                                                                       |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| the author                               | every atom except `sharing:manage`, project-wide                                                                       |
| anyone else with a complete view of main | `schema:view`, `comment:create`, `export:run`, `history:view`, `field:viewRestricted`, project-wide (review, not edit) |
| everyone else                            | the empty map, so the draft answers 404                                                                                |

These maps are the same on every object, so no main-project area or entity ids need to be
re-keyed into draft ids. The draft's map depends on the main project's grants, so its cache
key includes the main project's generations as well.

| Action                    | Needs                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| create a change request   | complete view + `comment:create` at the main project. A commenter can propose; that's the point                                                                                |
| approve / request changes | complete view + `schema:edit` at the main project, and not the author                                                                                                          |
| merge                     | at least one current approval (§4), and the merger's own `SchemaWriter` checks on main pass for every op. An editor of one area can't merge a change that touches another area |
| update from main          | the author only (as built: the draft's writes are the author's)                                                                                                                |

## 4. Reviews

`ChangeRequestReview` records `{ reviewer, verdict: approved | changes_requested, note, draftRevision }`.
`draftRevision` is the draft's `schemaRevision` at the time of the review. **An approval counts
only while the draft is unchanged since it was given.** Any edit in the draft (including
Update from main) makes earlier approvals stale, and the page shows them as stale. A
"changes requested" verdict blocks merging until that reviewer approves or the request is
updated.

## 5. Merge and Update from main

Both are one three-way function, `threeWay(base, ours, theirs)`, pure, in
`packages/schema-model`. It takes three models in the same id space and returns
`{ changes: SchemaDiff, conflicts }`.

- **The three models.** `base` is the starting-point snapshot. `theirs` is the draft's live
  IR, translated to main ids through `idMap`. `ours` is the main project's live IR.
- **What counts as a conflict.** The diff base → theirs is the change set. An entry conflicts
  when the same object also differs between base and ours (changed on both sides), or when
  one side deletes an object the other side changed. Comparison ignores `version` and layout.
- **Merge** is allowed only with no conflicts.
  1. The change set goes through `opsFromDiff` (expected versions come from main's live IR).
  2. `planRestore` turns those ops into **one batch, at most 2000 ops**. A bigger change
     answers `change_request_too_large`. One batch keeps the merge atomic, because a
     multi-batch write isn't atomic yet (see the `ponytail:` note in `restore-plan.ts`).
  3. `SchemaWriter.apply` runs with the **merger's** context. Its `beforeWrite` writes the
     "Before merging" snapshot and marks the request `merged` in the same transaction.
  4. A version conflict at write time becomes `409 change_request_conflict`, and the page
     reloads with the new conflicts.
- **Update from main** brings the main project's changes since `base` into the draft.
  1. It runs the same function the other way round: main's changes are applied to the draft
     through SchemaWriter with the author's context.
  2. New main objects get fresh draft ids, which are added to `idMap`.
  3. On a conflicting object, main's version wins in the draft and the author redoes that edit.
     The page says which objects were reset.
  4. Then `base` moves to a new snapshot of main.
- **Layout.** Moving an existing table in the draft doesn't change its position in main.
  Tables created in the draft keep their position (Q5).

## 6. Data

```prisma
model ChangeRequest {
  id              String              @id @default(cuid())
  projectId       String              // the main project
  draftProjectId  String              @unique
  authorId        String?
  title           String
  description     String              @default("")
  status          ChangeRequestStatus @default(open)   // open | merged | closed
  baseSnapshotId  String
  idMap           Json                // { [draftId]: mainId }
  mergedById      String?
  mergedAt        DateTime?
  closedAt        DateTime?
  createdAt / updatedAt
  reviews         ChangeRequestReview[]
  @@index([projectId, status, createdAt(sort: Desc)])
}

model ChangeRequestReview {
  id              String
  changeRequestId String
  reviewerId      String?
  verdict         ReviewVerdict       // approved | changes_requested
  note            String              @default("")
  draftRevision   BigInt
  createdAt       DateTime
}
```

Plus `Project.draftOfId String?` (FK to `Project`, cascade) and one requested-reviewers list
(`ChangeRequest.reviewerIds String[]`).

## 7. API

All under one controller, with a `change-requests.routes.spec.ts` table. Routes that name the
project use `@RequirePermission` or `@RequireProjectAccess`. Routes addressed by id are
`@Authenticated()`, and the service works out the project and answers 404 when the caller
fails the §3 check, like exports do.

| Route                                         | Does                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------ |
| `POST /projects/:projectId/change-requests`   | fork, returns `{ id, draftProjectId }`                                   |
| `GET /projects/:projectId/change-requests`    | list (empty for a caller without a complete view)                        |
| `GET /change-requests/:id`                    | summary, reviews, `changes` diff, `conflicts`, `canMerge` + reason       |
| `GET /change-requests/:id/migration`          | migration SQL for the change set (`SnapshotsService.plan`)               |
| `POST /change-requests/:id/reviews`           | `{ verdict, note }`                                                      |
| `POST /change-requests/:id/update-from-main`  | §5                                                                       |
| `POST /change-requests/:id/merge`             | `{ expectedDraftRevision }`, so an edit made after review can't sneak in |
| `POST /change-requests/:id/close` / `/reopen` | author or project editor; the draft stays, read-only while closed        |

Notifications (new types in `NOTIFICATION_TYPES` and `EMAIL_PREF`):

- `change_request.review_requested` goes to the requested reviewers.
- `change_request.reviewed` goes to the author.
- `change_request.merged` goes to the author and the reviewers.

## 8. Web

- `features/change-requests/`: the list (Changes tab), the request page
  `/[org]/p/[projectId]/changes/[id]` reusing the history diff and migration components, and
  the **Propose a change** dialog in the project header.
- The draft canvas is the normal project route. The only addition is the banner, shown when
  the IR's project has `draftOfId`.
- No engine id is hard-coded; the migration panel reads the engine facet like History does.

## 9. Build order

1. `threeWay` in `schema-model`, with property tests: no conflicts when only one side changed,
   symmetry of conflicts, and that applying `changes` to `ours` gives `theirs` when `ours` equals `base`.
2. `draftOfId`, resolver rule, hiding drafts from lists (tests for 404 and the three maps).
3. Fork + `ChangeRequest` + list/read routes.
4. Reviews, merge, update from main, close/reopen.
5. Notifications.
6. Web: Propose dialog, banner, Changes tab, request page.
7. e2e workflow 11: an analyst proposes, the owner requests changes, the analyst edits, the
   owner approves and merges; plus a conflict case.

## 10. Open questions

| #   | Question                                                          | Default                                                                                                                    |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Q1  | A new `schema:review` atom instead of "`schema:edit` to approve"? | **No.** Atoms are fixed by C5 and editors are the natural reviewers. Add one when a team asks for reviewers who can't edit |
| Q2  | Change requests for area-scoped users?                            | **Later.** It needs a redacted fork and re-keyed maps. Complete view only in v1                                            |
| Q3  | How many approvals to merge?                                      | **One**, from someone other than the author. A per-project setting comes later                                             |
| Q4  | Protect the main project (direct edits only through requests)?    | **No** in v1. Requests are opt-in; direct editing keeps working                                                            |
| Q5  | Merge layout moves of existing tables?                            | **No.** Layout isn't reviewed, so it shouldn't change main silently. New tables keep their position                        |
| Q6  | Copy and merge per-object docs?                                   | **No** in v1. The fork copies schema only; docs stay on the main project                                                   |
| Q7  | Conflict resolution beyond "main wins, redo your edit"?           | **Later.** A per-object "keep mine / take main" picker when the simple rule is not enough                                  |
| Q8  | Merges bigger than 2000 ops?                                      | **Refuse** (`change_request_too_large`) until SchemaWriter can run several batches in one transaction                      |
| Q9  | Can the author merge their own request after approval?            | **Yes**, if they pass the §3 merge check. The approval is what's required, not who clicks                                  |
