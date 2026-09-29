# Phase 4 — history & diff, rename on import, comments, notifications

Status: **approved 2026-09-28, with the recommendation on every question in §6.** Realtime
(decision 105) is built; this document covers the three parts that had no design. Permission rules are not
re-decided here: they are doc 05's L15–L19, R21′ and §7.8, and each section names the one it
applies. Five questions at the end need an answer before build.

**Not in Phase 4:** `migrationGenerator` (the overview puts it in Phase 5; REVIEW.md's "Phase 4"
mention is stale), the activity-log screen, canvas comment-count badges, digest emails, the
`apps/worker` split.

---

## 1. History and diff

What exists: `POST/GET /projects/:id/snapshots`, `GET …/snapshots/:id`, `GET …/:fromId/diff/:toId`,
`POST …/:id/restore`, all gated as doc 05 §2.2 says (`history:view` to read, `schema:edit` +
R21′ to restore). Diffs are computed between two **redacted** models (L18). What is missing is
any screen, and a way to compare against _now_.

### 1.1 API additions

| Route                                               | Marker                               | What                                                                                       |
| --------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| `GET /projects/:id/snapshots/:snapshotId/diff/live` | `@RequirePermission('history:view')` | diff snapshot → current live IR, both redacted with the caller's **current** context (L18) |
| `DELETE /projects/:id/snapshots/:snapshotId`        | `@RequirePermission('schema:edit')`  | §7.8 already allows it; `kind = manual` only (auto ones age out, §1.3)                     |

Every diff response is the existing `SchemaDiff`, plus the counts the header needs computed
post-redaction (L8): `{ added, removed, changed, structural, governance }`.

### 1.2 Screen: `/[org]/p/[projectId]/history`

A second view of the project (tab next to "Canvas" in the project header), shown only when
the caller holds `history:view`.

- **Left: the snapshot list**, newest first — name, kind badge (`manual`, `import`, `restore`,
  `auto`), author, relative time. "Take snapshot" (name + optional note) for `schema:edit`.
- **Right: the diff.** Default comparison is _selected snapshot → current_. Picking a second
  snapshot switches to snapshot → snapshot.
  - Grouped by entity (`entriesByEntity`), each group collapsible; inside it one row per
    `DiffEntry`: added / removed / changed, and for `changed` the property list
    (`name: customer → customers`, `type: int4 → int8`).
  - Severity chips per row. The **"Hide cosmetic"** toggle is on by default (`ignoreCosmetic`);
    `governance` rows (restricted, PII, area moves) are never hidden by it and render with a
    warning tint.
  - "Show on canvas" on a group selects that entity on the canvas (the existing selection store
    the Queries tab already uses).
- **Restore** on a snapshot: a confirm dialog that shows the diff _current → snapshot_ summary
  ("3 tables removed, 12 changed") before the button. Disabled with a one-line reason when the
  caller does not have the full view (R21′); R28 already stops restore from rewriting
  access-control attributes.

### 1.3 Automatic snapshots

Today only `manual` snapshots are written. Phase 4 adds (Q4):

- `kind = import` immediately **before** every applied SQL import (sync and job paths).
- `kind = restore` immediately **before** a restore, so a restore is undoable.
- Both in the same transaction as the write they precede. The same transaction prunes this
  project's non-manual snapshots beyond the newest 50 that are older than 90 days (no scheduler
  needed); manual ones are never pruned.

---

## 2. Rename on import

**Why only here.** Inside a project, diffs match by id, so an in-app rename is already one
`changed` entry with a `name` change; nothing to confirm. The loss happens on **SQL re-import**:
`customer` renamed to `customers` in the pasted DDL arrives as a _new_ table. Additive merge
keeps both, and the old table's docs, comments, grants and saved-query links stay on the stale
copy. There is still **no inferred rename** (doc 04 §7.3): the generator only _proposes_; a
human confirms every pair, and only confirmed pairs are applied.

### 2.1 Flow

1. `POST /projects/:id/import/preview { source }` (`schema:edit`, R21′ like import itself, L19)
   → `{ creates: [...], existing: [...], renameCandidates: [...] }`. Nothing is written.
2. The import dialog shows "Looks like a rename?" cards: _`customer` → `customers` (5 of 6
   columns match)_ with **Rename** / **Keep both**. Field candidates appear inside a matched or
   renamed table: _`email` → `email_address` (same type, same position)_.
3. `POST /projects/:id/import { source, renames: [{ type, fromId, toName }] }`. Confirmed pairs
   are applied **first** as ordinary `update … { name }` ops through `SchemaWriter` (same
   batch, so the rename keeps the object id — docs, comments, grants and saved-query links
   follow it, and the saved-query re-check from Phase 2 fires). Then the additive merge runs as
   today: the renamed object now matches by logical key, and everything else is untouched.
   The large-import job path carries `renames` in its payload.

### 2.2 Candidate generator (in `packages/schema-model`, pure)

Pools: project entities **absent** from the SQL × SQL entities that **would be created**, same
namespace only (cross-namespace stays manual, doc 04 OQ10).

- **Entity pair** when field-name overlap is high: Jaccard over normalised field names ≥ 0.5
  with at least 2 shared names; or, for tables with ≤ 1 field, name similarity ≥ 0.7. Score =
  Jaccard, name similarity breaks ties. Each entity appears in at most one candidate (greedy by
  score). Unlike the deleted heuristic, a plain table rename with unchanged columns scores 1.0.
- **Field pair**, inside an entity that matched (by key or by a confirmed rename): an old field
  absent from the SQL × a new field, **same type required**, and (same ordinal **or** name
  similarity ≥ 0.6).
- Output carries the reason shown on the card (`5 of 6 columns match`, `same type, same
position`), never a percentage.

Only visible objects enter the pools (import already requires the full view, L19).

---

## 3. Comments

Data model exists (`comments`, threads by `rootId`, `mentionedIds`). Rules exist: §7.8
(create at the target entity with `comment:create`; edit/delete/resolve own; `docs:edit` may
resolve any thread), §8 (dropped with an invisible target; field comments follow field
visibility; body through `redactRichText`; guest viewers see `"A team member"` for authors
they cannot see), R21 (never reachable for share-link visitors).

### 3.1 API

| Route                                                               | Marker                                  | Notes                                                                                                                                       |
| ------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /projects/:id/comments?targetType&targetId`                    | `@RequireProjectAccess`                 | threads on one target; invisible target → 404                                                                                               |
| `GET /projects/:id/comments/counts`                                 | `@RequireProjectAccess`                 | `{ [entityId]: openThreads }` over visible targets only (L8); for the inspector list                                                        |
| `POST /projects/:id/comments`                                       | `@RequireProjectAccess` + service check | `{ targetType, targetId, parentId?, content }`; `comment:create` at the target entity                                                       |
| `PATCH /comments/:id` · `DELETE /comments/:id`                      | `@Authenticated`                        | own only; invisible → 404, visible-not-own → 403                                                                                            |
| `POST /comments/:id/resolve` · `…/reopen`                           | `@Authenticated`                        | own thread, or `docs:edit` at the target                                                                                                    |
| `GET /projects/:id/comments/mention-candidates?targetType&targetId` | `@RequireProjectAccess`                 | users who can **see the target** (`resolveResource` inverse, doc 05 §7.7 item 4) — the same rule for members and guests; name + avatar only |

Deleting a comment that has replies leaves a tombstone ("Comment deleted") so the thread
survives; a leaf is hard-deleted (Q2). Realtime sends `comments:changed { targetType, targetId }`
to sockets that can see the target; clients refetch that thread.

### 3.2 UI

A **Comments** tab in the inspector for the selected table or column: open threads first,
then resolved (collapsed). The composer is TipTap (already a dependency) with the official
`@tiptap/extension-mention` (Q5), fed by `mention-candidates`. If the author mentions someone
who cannot see the target, the composer says _"Bob cannot see this table — they will not be
notified"_ (L17) — the candidate list already excludes them, so this only triggers on pasted
mentions.

---

## 4. Notifications

Table exists (`notifications`, open `type` set validated in contracts); `users.notificationPrefs`
exists (`emailMentions`, `emailCommentReplies`, `emailAccessRequests`, `emailInvites`).

- **Types in Phase 4:** `comment.mentioned`, `comment.replied` (previous participants of the
  thread, not the author), `access.requested` (already written by access requests today),
  `access.decided`, `resource.shared` (grant created for you).
- **L17 at send time:** each recipient's current `VisibilityContext` decides; an invisible
  target means **no notification and no email**. Title and body are templated from ids and
  rendered per recipient (L7), never stored prose containing hidden names.
- **Email:** immediate, only for types whose pref is on (Q3). `inAppDigest` stays unbuilt.
- **API** (`@Authenticated`): `GET /notifications?cursor` (newest first, unread count),
  `POST /notifications/:id/read`, `POST /notifications/read-all`,
  `PATCH /me/notification-prefs`.
- **UI:** a bell in the top bar with the unread count and a dropdown list (click → mark read →
  open `url`); prefs as a section on the existing Security settings page, renamed "Account".
  Delivery: the socket joins a `user:<id>` room on connect and gets `notification:new`; without
  a socket the bell refetches on focus.

---

## 5. Build order

Realtime (in progress) → comments API + tab → notifications (depends on comments) → history
screen + live diff + auto snapshots → rename preview + generator. Each lands with unit tests and
the route specs the boot sweep needs; one e2e per area.

## 6. Questions

| #   | Question                                                                                                                    | Recommendation                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | A **confirmed** rename on import updates the existing object's name. That bends "import is additive; existing objects win". | **Allow it, for confirmed renames only.** Nothing is inferred or deleted, and without it re-imports strand docs and grants on stale copies. |
| Q2  | Deleting a comment with replies.                                                                                            | **Tombstone** the root, hard-delete leaves.                                                                                                 |
| Q3  | Notification email timing.                                                                                                  | **Immediate**, per-type opt-out via the existing prefs; no digest yet.                                                                      |
| Q4  | Automatic snapshots before import and restore.                                                                              | **Yes**, same transaction, pruned after 90 days beyond the newest 50.                                                                       |
| Q5  | New dependency `@tiptap/extension-mention`.                                                                                 | **Yes** — official, small, and hand-rolling mentions in ProseMirror is the larger diff.                                                     |
