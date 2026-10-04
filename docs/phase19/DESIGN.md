# Workspace-level sharing (roadmap 19)

Status: **built** 2026-10-04 (approved the same day with every default). This reverses
Phase 1 Q1 ("do not add it") at the owner's request, as a new row as `ROADMAP.md` requires.

**As built**, where it differs from the text below:

- Routes are org-scoped like the other org routes: `GET/POST
/organizations/:slug/workspaces/:id/grants` and `DELETE
/organizations/:slug/workspace-grants/:id`. A POST for an existing (workspace, principal)
  updates it, as project grants do (R10).
- Sharing a workspace lives in **Settings → Workspaces** (owners), not a sidebar menu: the app
  has no workspace sidebar. Org owners aren't offered as principals (a grant to one is inert, R13).
- The project's access list carries workspace grants with `resourceType: 'workspace'`; the
  dialog shows them as inherited ("Workspace: Data") and its R15 preview ranks them past the
  project. They are changed only on the Workspaces page.
- Deleting a group deletes its workspace grants; a custom role used by a workspace grant can't
  be deleted (archive it), as for project grants.
- Tests: resolver unit tests for the level (nearest-wins both ways, area still decides, union
  across principals, guest ceiling, foreign workspace dropped, expiry), the client preview, and
  e2e workflow 20. The golden matrix and the property spec don't generate workspace grants yet.

## Problem

Workspaces group projects ("Payments", "Data platform"), but access is granted one project at
a time. "Give the analysts Viewer on everything in Data platform" is N grants today, and the
next project created there is invisible to them until someone remembers to share it. Q1
predicted this: it's cheap to add early and gets harder later.

## Decisions to approve

### 1. A workspace grant is the level above a project

The cascade becomes **workspace → project → area → entity**, with the rule that already
holds for the other three (R15): **for each principal, the nearest level wins**. So:

- Viewer on workspace _Data_ → Viewer on every project in _Data_, including projects created
  later.
- Viewer on _Data_ plus Editor on project _Warehouse_ → Editor on _Warehouse_.
- Editor on _Data_ plus Viewer on project _Raw_ → Viewer on _Raw_. A project grant can
  narrow, the way an area grant already narrows a project grant.
- Different principals still union (R16): a group's workspace grant plus a user's own grants
  add up as today. The R17 ceilings (guests never get `sharing:manage`) apply as today.

Org owners are unaffected: they already see everything (R13).

### 2. Stored in its own table, not in `access_grants`

`access_grants.project_id` is NOT NULL, every read is filtered by it, and a CHECK, two
triggers and share links all lean on that. Widening `resource_type` would also widen the
share-link and access-request DTOs, which share its schema. So:

`workspace_grants (id, organization_id, workspace_id, principal_type, principal_id, role_id,
can_use_ai, can_view_restricted, note, created_by_id, expires_at, timestamps)`, unique on
`(workspace_id, principal_type, principal_id)`, FK to workspaces with `ON DELETE CASCADE`,
role FK like `access_grants`. Principals are `user` and `group` only: no share links and no
email invites at workspace level (Q3).

The resolver reads the project's `workspace_id` (one more column in `readProjectRows`) and
the principal's workspace grants in the same query as its project grants. `indexGrants` and
`cascadeFor` gain the fourth level; nothing else in `computeProjectMap` changes.

### 3. Cache invalidation

Writing a workspace grant bumps the **org generation** (`og`), which already invalidates every
cached map in the org. Workspace grants change rarely, so a finer counter isn't worth a new
column (Q4). Moving a project to another workspace doesn't exist today; if it's ever added it
must bump the project's generation.

### 4. Who may create workspace grants

**Org owners only** (`@RequireOrgRole('owner')`). Admins see only projects they're granted
(R13); letting an admin grant themselves a workspace would let them see every project in it,
which is exactly what R13 rules out.

### 5. API and web

- `GET/POST /workspaces/:id/grants`, `PATCH/DELETE /workspace-grants/:id`, through
  `AccessWriter` (an org-level advisory lock, the `og` bump, an audit row
  `workspace_grant.created|updated|deleted`).
- The project "Who has access" view lists inherited workspace grants with "from workspace
  Data", read-only there, like an area grant viewed from an entity.
- Sidebar: each workspace's menu gets **Share workspace…** (owners only), a dialog with the
  same add-grant form (role, AI, restricted columns, expiry) minus share links.
- `listWorkspaces` shows a guest the workspaces they hold a grant on.

## Tests

- `resolve.spec.ts` and the property spec gain the workspace level: nearest-wins per principal,
  union across principals, guests' ceiling, expiry.
- `golden-matrix.spec.ts` + `permission-matrix.csv`: new rows for workspace grants alone, with a
  narrowing project grant, and via a group.
- Service: owner-only creation, the `og` bump, cascade delete with the workspace, audit rows.
- e2e: a group gets Viewer on a workspace; a project created afterwards is visible to its
  member in the browser; a project-level Viewer grant narrows an Editor workspace grant.

## Open questions

| #   | Question                                     | Default                                                                           |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------- |
| Q1  | Workspace vs project grant for one principal | **Nearest level wins** (R15), so a project grant can narrow a workspace grant     |
| Q2  | Who creates workspace grants                 | **Org owners only** (R13)                                                         |
| Q3  | Principals                                   | **Users and groups.** No share links, no pending email invites at workspace level |
| Q4  | Invalidation                                 | **Bump `og`** on every workspace grant write                                      |
| Q5  | Storage                                      | **New `workspace_grants` table**; `access_grants` untouched                       |
| Q6  | Access requests ("ask for access to Data")   | **Not now.** Requests stay per project                                            |
