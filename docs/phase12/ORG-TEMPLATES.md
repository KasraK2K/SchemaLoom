# Phase 12b–12c: areas in templates, and org templates

Status: **proposed 2026-10-05**. Roadmap rows 12b (areas in the built-in templates) and 12c
("save this project as a template"). Builds on `DESIGN.md` (templates) and Phase 23 (area
cards), which makes areas worth shipping in a template.

## 0. The decisions

| #   | Question                         | Decision                                                                                                                                                                      |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How built-in templates get areas | **An `areas` list on `ProjectTemplate`**, applied right after the import as one ops batch.                                                                                    |
| D2  | What an org template stores      | **A copy of the model** (tables, columns, links, indexes, docs, areas, positions), not SQL. SQL would lose docs, areas and layout.                                            |
| D3  | Who may save one                 | **Someone who sees the whole project and can share it** (`sharing:manage`, complete view). A template shows the schema to the whole org, which only a sharer could do anyway. |
| D4  | Who may use one                  | **Anyone in the org who may create projects.** It's listed with the built-in templates.                                                                                       |
| D5  | How a project is made from one   | **The change-request fork path**: fresh ids, then `planImport` batches through `SchemaWriter`. No second write path.                                                          |

## 1. Areas in the built-in templates (12b)

```ts
// packages/engine-sdk/src/templates.ts
export interface ProjectTemplate {
  /* …existing… */
  readonly areas?: readonly { name: string; color: string; tables: readonly string[] }[];
}
```

- Each engine's templates get areas: e-commerce (Catalog, Orders, Customers), SaaS (Accounts,
  Billing), blog (Content, People), SQLite todo (Tasks), and so on.
- **Applying them:** after the import job completes, the web sends one ops batch: `create area`
  for each, plus `update entity { areaId }` for each named table it finds. A table name that
  isn't there is skipped. It runs through `SchemaWriter` like any edit, then auto layout runs
  so the cards come out tidy.
- The engines' `templates/import-cleanly` conformance test also checks that every table an
  area names exists in the template's source.

## 2. Org templates (12c)

### 2.1 What the user sees

- **Save:** project menu → **Save as template…** asks for a name and summary, with **Include
  docs** (on) and **Include layout** (on). The dialog says plainly: "Everyone in Acme who can
  create projects will see these 14 tables and their docs." Saving is refused, with the
  reason, when the user can't see the whole project.
- **Use:** the new-project screen lists **Your organization's templates** above the built-in
  ones, with name, summary, table count, engine and who saved it.
- **Manage:** Settings → **Templates** lists them, with rename and delete for the saver, owners
  and admins. Saving again from the same project offers **Replace "Core schema"**.
- A project made from a template doesn't remember it (Phase 12 Q2), so changing a template
  never touches projects already made.

### 2.2 Data

```prisma
model OrgTemplate {
  id              String   @id @default(uuid()) @db.Uuid
  organizationId  String   @map("organization_id") @db.Uuid
  name            String
  summary         String   @default("")
  engineId        String   @map("engine_id")
  engineMajor     Int      @map("engine_major")
  engineVersion   String   @map("engine_version")    // the target version, e.g. "16"
  model           Json                               // SchemaModel, ids as saved
  tableCount      Int      @map("table_count")
  sourceProjectId String?  @map("source_project_id") @db.Uuid  // for "Replace"; SetNull
  createdById     String?  @map("created_by_id") @db.Uuid
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)
  @@index([organizationId])
}
```

**What the copy leaves out:** comments, history, grants, change requests, saved queries and
connections. With **Include layout** off, positions are dropped and auto layout runs on use.

### 2.3 Routes

| Route                                                | Marker / check                                         | Does                              |
| ---------------------------------------------------- | ------------------------------------------------------ | --------------------------------- |
| `POST /projects/:projectId/save-as-template`         | `@RequirePermission('sharing:manage')` + complete view | Save or replace.                  |
| `GET /organizations/:orgSlug/templates`              | `@Authenticated`, org member in service                | List, no model.                   |
| `PATCH/DELETE /organizations/:orgSlug/templates/:id` | `@Authenticated`, saver, owner or admin                | Rename or delete.                 |
| `POST /projects` with `{ orgTemplateId }`            | existing `@RequireOrgRole` (may create projects)       | Create the project, then fill it. |

- **Save** loads the live model (`loadLiveProject`), checks `hasCompleteView`, as the
  change-request fork does, and stores it. The live model stays inside `src/snapshots`; the
  saved JSON is the same model the saver can see in full, so nothing is unredacted for them.
- **Use** runs `freshIds` and the fork's `planImport` batches into the new project, inside the
  create flow. On failure the half-made project is deleted, as the fork does.
- **Engine major:** a template saved on an older engine major is listed as "Made with an older
  engine version, ask the saver to save it again" and can't be used. Props are never converted
  silently (CLAUDE.md, engine majors).

## 3. Tests

- Unit: area application (missing tables skipped), the conformance check on area table names.
- Api integration: a partial viewer can't save (403); a member without project creation
  can't use one; a project made from a template has fresh ids, the docs and areas, and no
  comments or grants; deleting the source project keeps the template; an old-major template
  is refused.
- Routes spec for the new routes.
- E2E (workflow 14): a template opens with its areas drawn. Save a project as a template,
  create a project from it in the same org, and see the same tables and cards.

## 4. Out of scope

- Sharing templates across orgs, or a public gallery.
- Template versions ("v2 of Core schema"). **Replace** overwrites.
- Templates for Read-a-database or the CLI (Phase 12 Q5).

## 5. Open questions (defaults are the recommendation)

| #   | Question                            | Default                                                                                   |
| --- | ----------------------------------- | ----------------------------------------------------------------------------------------- |
| Q1  | Who may save                        | **`sharing:manage` plus a complete view** (D3).                                           |
| Q2  | Include docs by default             | **Yes.** Docs are much of a house template's value, and the dialog says they're included. |
| Q3  | Template from an older engine major | **Refuse it until it's saved again**, rather than converting props.                       |
| Q4  | A limit on templates per org        | **50**, so the new-project screen stays a list, not a search.                             |
