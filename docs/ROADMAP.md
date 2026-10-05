# SchemaLoom roadmap

This is the single list of what is built, what comes next, and in what order. It is for human
contributors and AI agents alike. Last updated 2026-10-05.

## How this file works

- **One row per feature.** Every row has a status and, once work starts, a design doc.
- **Design before code.** A feature moves from `idea` to `proposed` when it has a design doc
  under `docs/phaseN/DESIGN.md`. Code starts only after the owner marks it `approved`. Each
  design doc ends with an open-questions table, and every row in it has a default.
- **Keep it current.** Whoever changes a feature's status updates this file in the same
  commit.
- **Don't re-open decisions** marked "user decision" in the design docs or in `CLAUDE.md`.
  If one has to change, propose it here as a new row.

| Status     | Meaning                                  |
| ---------- | ---------------------------------------- |
| `idea`     | worth doing, not designed yet            |
| `proposed` | design doc written, waiting for approval |
| `approved` | design approved, ready to build          |
| `building` | in progress                              |
| `built`    | merged, covered by tests                 |
| `parked`   | deliberately not now (the row says why)  |

## Built

| Phase | What                                                                                   | Design                                  |
| ----- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| 1     | Canvas, IR, engine SDK, PostgreSQL engine, permissions, SQL import (additive), exports | `docs/phase1/` (start at `00-OVERVIEW`) |
| 2     | Saved queries, `QueryValidator`                                                        | `docs/phase1/00-OVERVIEW.md`            |
| 3     | Custom roles, sharing (groups, grants, share links, access requests)                   | `docs/phase1/05-*`                      |
| 4     | Realtime, rename detection on import, history and diff                                 | `docs/phase4/DESIGN.md`                 |
| 5     | Migration SQL, AI assistant, docs mode, PDF export                                     | `docs/phase5/DESIGN.md`                 |

## Next, in priority order

The order follows one idea: first get people's real schemas in with no effort, then give them
a reason to come back every week, then reach more databases and teams.

| #   | Feature                                                                        | Status     | Design                                 | Why it matters                                                                                                     |
| --- | ------------------------------------------------------------------------------ | ---------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 6a  | **Import a project from a live database**                                      | `built`    | `docs/phase6/DESIGN.md` §1–§5          | Most users already have a database. Redrawing it by hand is where they give up.                                    |
| 6b  | **Drift check: design vs. live database**                                      | `built`    | `docs/phase6/DESIGN.md` §6             | "Production has 4 changes your design doesn't," plus the SQL to reconcile. The reason to come back every week.     |
| 6c  | Saved connections (Sync now, Compare now)                                      | `built`    | `docs/phase6/SAVED-CONNECTIONS.md`     | Sync and compare later without re-typing credentials. Scheduled checks and alerts follow as 6d.                    |
| 6d  | Scheduled drift checks + alerts                                                | `built`    | `docs/phase6/SCHEDULED-DRIFT.md`       | Turns Compare into a monitor: managers hear when the database moves away from the design.                          |
| 7   | **Prisma export**                                                              | `built`    | `docs/phase7/DESIGN.md`                | For many teams the ORM file is the source of truth. A second export format of the engine.                          |
| 7b  | Prisma import                                                                  | `built`    | `docs/phase7/PRISMA-IMPORT.md`         | The other half of the round trip (`DESIGN.md` Q4). Wait until the export is in use.                                |
| 8   | Drizzle / TypeORM / Django exporters                                           | `built`    | `docs/phase8/DESIGN.md`                | Same contract as 7. Build only the ones users ask for.                                                             |
| 9a  | MySQL / MariaDB: design, import, export                                        | `built`    | `docs/phase9/DESIGN.md`                | Roughly doubles the market. The first real test of the engine boundary (design §5).                                |
| 9b  | MySQL / MariaDB: live database, Sync, drift                                    | `built`    | `docs/phase9/DESIGN.md` §4, §6         | Drift is what brings people back every week.                                                                       |
| 9c  | MySQL / MariaDB: migration SQL                                                 | `built`    | `docs/phase9/DESIGN.md` §4, §6         | Migrations from history and drift, with MySQL's non-transactional DDL said up front.                               |
| 9d  | MySQL / MariaDB: query validation, AI assistant                                | `built`    | `docs/phase9/DESIGN.md` §4, §6         | Parity with PostgreSQL for saved queries and the assistant.                                                        |
| 10  | Schema change requests (propose → review → merge)                              | `built`    | `docs/phase10/DESIGN.md`               | PR-style review for schema edits, on top of comments, history and migrations. What teams pay for.                  |
| 10b | Protected projects: changes only via requests                                  | `built`    | `docs/phase10/PROTECTED-PROJECTS.md`   | Makes review mandatory where it matters. Without it, anyone with edit access skips the request.                    |
| 10c | Propose first, name on submit; protected = locked                              | `built`    | `docs/phase10/PROPOSE-FIRST.md`        | Edit first, explain after. A protected project offers no edits at all, layout included; merges carry moves.        |
| 11  | CLI + CI: `schemaloom pull`, `diff --fail-on-drift`                            | `built`    | `docs/phase11/DESIGN.md`               | Puts SchemaLoom in the deploy pipeline. Reuses 6b's drift endpoint with an API token.                              |
| 12  | First-run experience: sample projects, templates                               | `built`    | `docs/phase12/DESIGN.md`               | A new user currently lands on an empty canvas.                                                                     |
| 13  | SQLite engine                                                                  | `built`    | `docs/phase13/DESIGN.md`               | Cheap second or third engine, popular with indie developers.                                                       |
| 14  | Enterprise: SAML/OIDC SSO, audit log viewer                                    | `built`    | `docs/phase14/DESIGN.md`               | Unparked 2026-10-04 at the owner's request. Sign-in through the company IdP; the audit log finally readable.       |
| 15  | Remaining Phase 3 login paths (magic link, TOTP…)                              | `built`    | `docs/phase1/00-OVERVIEW.md` Q28       | Built with Phase 3 (`267445f`, 2026-09-28); this row was never updated. e2e coverage is row 20 §4.                 |
| 16  | Invite-only sign-up + org member invites                                       | `built`    | `docs/phase16/DESIGN.md`               | A self-hosted install should not let strangers in. The first account is the owner; everyone else is invited.       |
| 17  | Appearance themes (Studio, Blueprint, Float, Compact)                          | `built`    | `docs/phase17/APPEARANCE.md`           | People work differently: four layouts, densities and type styles, each with colour variants, saved per account.    |
| 18  | AI writes ORM code (model code + queries in Prisma, Drizzle, TypeORM, Django)  | `built`    | `docs/phase18/AI-CODE.md`              | Teams work in their ORM, not in SQL. The answer they can paste straight into their code.                           |
| 19  | Workspace-level sharing                                                        | `built`    | `docs/phase19/DESIGN.md`               | One grant covers every project in a workspace, including later ones. Reverses Phase 1 Q1 at the owner's request.   |
| 20  | Ops: worker process, realtime over Redis, CI cache, row 15 e2e                 | `built`    | `docs/phase20/DESIGN.md`               | The unscheduled Phase 1 leftovers (worker split, Q33, Q32) and tests for the login paths.                          |
| 21  | MCP server for AI agents (`schemaloom mcp`)                                    | `built`    | `docs/phase21/DESIGN.md`               | A developer's own agent asks about the schema while coding. Same view as the built-in assistant, no server AI key. |
| 21b | Agents propose schema changes (`propose_change`)                               | `built`    | `docs/phase21/DESIGN.md` §9            | An agent adds the tables its task needs, as a change request a person reviews and merges. Never a direct write.    |
| 22  | Describe it, get a schema (AI drafts tables and relations from a description)  | `built`    | `docs/phase22/DESIGN.md`               | Describe a whole app or one feature; the AI builds on the existing tables. Draft, refine, review, then import.     |
| 23  | Area cards: group related tables in a coloured card; auto layout keeps them in | `built`    | `docs/phase23/AREA-CARDS.md` §7        | `books` and `book_shelves` belong together. Areas exist but are never drawn, and no screen creates one.            |
| 17b | Org default appearance for new members                                         | `built`    | `docs/phase17/ORG-DEFAULT.md`          | New people start in the team's look without being told where the setting is.                                       |
| 12b | Areas in the built-in templates                                                | `built`    | `docs/phase12/ORG-TEMPLATES.md` §1     | A template opens already organised into cards (needs 23).                                                          |
| 12c | Org templates ("save this project as a template")                              | `proposed` | `docs/phase12/ORG-TEMPLATES.md` §2     | A house schema (audit columns, users, tenants) every new project starts from.                                      |
| 22b | Preview an AI draft on the canvas (ghost tables)                               | `proposed` | `docs/phase22/DRAFT-PREVIEW.md`        | See where the new tables sit and what they connect to before importing.                                            |
| 14b | SCIM provisioning + IdP group mapping                                          | `proposed` | `docs/phase14/DIRECTORY-SYNC.md` §1–§2 | Leavers lose access the moment HR removes them; teams in the directory become groups.                              |
| 14c | Sign-in from the IdP's dashboard (bounced, never trusted)                      | `proposed` | `docs/phase14/DIRECTORY-SYNC.md` §3    | The Okta or Entra app tile just works, without accepting unrequested assertions.                                   |
| 14d | Stream the audit log to a SIEM                                                 | `proposed` | `docs/phase14/AUDIT-STREAMING.md`      | Security teams watch SchemaLoom events in Splunk or Datadog, next to everything else.                              |

**6a/6b verified (2026-09-30)** with pg_dump 18.6 in Docker: the api image builds, the engine's
live spec and workflow 10 pass. That run found pg_dump 17.6+'s `\restrict` lines, which the
importer now skips like comments.

**6a/6b additions (2026-09-30, `docs/phase6/DESIGN.md` §10–§11), built:** SSH tunnels (key or
password, optional host-key pin), CA and client certificate files, and
`docker compose up -d` for the whole app with `pg_dump` inside, so nothing
has to be installed on the host. Checked end to end against a TLS-only Postgres behind an
OpenSSH bastion.

## Known gaps in built features

Small fixes that don't need a design doc. Pick one up freely.

- Area cards (row 23): the canvas Ctrl/Cmd+Z undoes positions only, so Group, Ungroup, add
  and remove are one History revision each but not undoable from the keyboard; removing the last
  table leaves an empty, undrawn area (only Ungroup deletes one). See `phase23/AREA-CARDS.md` §7.

- Built 2026-10-04: `refs` (doc 03 §3.1) are persisted. Every write recomputes them for the
  project (`src/schema/refs.ts`); before this no write stored them, so VisibilityFilter
  blanked every default, CHECK and view body for partial viewers and couldn't badge an index
  or constraint name mentioning a hidden column. Existing installs run
  `node dist/refs-backfill.cli.js` once (`docs/deploy.md`).
- Built 2026-10-04: e2e workflow 17 covers rows 8, 7b, 18 and 13 (ORM exports, Prisma import,
  model code, `.db` upload in the browser). It found that models pasted without a
  `datasource` block failed to import; they now read as the project's own database.
- Built 2026-10-04: the AI panel runs end to end without a key. The e2e api's
  `ANTHROPIC_BASE_URL` points at `e2e/scripts/fake-anthropic.ts`, which records what it is
  sent, so workflow 3 covers Code mode in the browser and checks that a masked column never
  reaches the provider. Locally it runs with `E2E_FAKE_AI=1` once Playwright starts the api.
- Built 2026-10-05: CI runs the e2e suite (`e2e` job in `.github/workflows/ci.yml`) against
  Postgres, Redis, MinIO, Mailpit and Keycloak, and uploads the Playwright report on failure.
  The job also runs MariaDB 11.4 for workflow 15 and fails early if the runner has no
  `pg_dump` (workflows 10 and 12), so neither skips there.

- Built 2026-10-04: a view's text no longer reads as drift. Servers re-print a view body
  (pg_dump adds casts and `public.`, MySQL qualifies and aliases every column, MariaDB drops
  parentheses), so drift asks the engine (`EngineDefinition.sameViewBody`) whether two bodies
  parse to the same query once those spellings are undone. A join written with unqualified
  columns matches too: drift passes the database's columns, so each bare name is owned by the
  one joined table that has it (a name two tables share is left alone).
- Built 2026-10-02 with 9b: drift no longer reports SchemaLoom-only attributes (docs, PII and
  restricted flags, areas) or store defaults (`customTypeId: null`, `asc` index columns) as
  changes, for every engine. Found by reading a live MariaDB. The PostgreSQL importer leaves
  out the same fields, so its drift had the same noise.
- Built 2026-10-01: area-scoped export (Q29), `POST /areas/:id/exports` for
  server formats, plus a Scope choice in the Export menu. Images stay project-only, because
  the browser canvas is not cut to one area.
- Built 2026-10-02: `COMMENT ON` in imported SQL becomes docs (`docs/phase12/DESIGN.md` §5).
  Tables, views and columns defined in the same source get a doc; existing docs are never
  replaced, and only callers with `docs:edit` write them. A comment on a table that is not in
  the source (a migration commenting on an existing table) is still reported as ignored.
