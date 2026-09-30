# SchemaLoom roadmap

This is the single list of what is built, what comes next, and in what order. It is for human
contributors and AI agents alike. Last updated 2026-09-29.

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

| #   | Feature                                             | Status     | Design                               | Why it matters                                                                                                 |
| --- | --------------------------------------------------- | ---------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 6a  | **Import a project from a live database**           | `building` | `docs/phase6/DESIGN.md` §1–§5        | Most users already have a database. Redrawing it by hand is where they give up.                                |
| 6b  | **Drift check: design vs. live database**           | `building` | `docs/phase6/DESIGN.md` §6           | "Production has 4 changes your design doesn't," plus the SQL to reconcile. The reason to come back every week. |
| 6c  | Saved connections + scheduled drift alerts          | `idea`     | `docs/phase6/DESIGN.md` §7 (outline) | Turns 6b from a button into a monitor. Needs encrypted credential storage, so it's split out.                  |
| 7   | ORM round-trip: Prisma export first, then import    | `idea`     | —                                    | For many teams the ORM file is the source of truth. An exporter plugs into the existing exporter contract.     |
| 8   | Drizzle / TypeORM / Django exporters                | `idea`     | —                                    | Same contract as 7. Build only the ones users ask for.                                                         |
| 9   | Second engine: MySQL / MariaDB                      | `idea`     | —                                    | Roughly doubles the market. The engine boundary is built for this. Wait until 6a–6b are proven on PostgreSQL.  |
| 10  | Schema change requests (propose → review → merge)   | `idea`     | —                                    | PR-style review for schema edits, on top of comments, history and migrations. What teams pay for.              |
| 11  | CLI + CI: `schemaloom pull`, `diff --fail-on-drift` | `idea`     | —                                    | Puts SchemaLoom in the deploy pipeline. Reuses 6b's drift endpoint with an API token.                          |
| 12  | First-run experience: sample projects, templates    | `idea`     | —                                    | A new user currently lands on an empty canvas.                                                                 |
| 13  | SQLite engine                                       | `idea`     | —                                    | Cheap second or third engine, popular with indie developers.                                                   |
| 14  | Enterprise: SAML/OIDC SSO, audit log viewer         | `parked`   | —                                    | Wait until a paying customer asks. The audit log data already exists.                                          |
| 15  | Remaining Phase 3 login paths (magic link, TOTP…)   | `parked`   | `docs/phase1/00-OVERVIEW.md` Q28     | Cut on purpose in Q28. Additive when needed.                                                                   |

**6a/6b status (2026-09-30):** code, unit tests and the e2e workflow (`workflow-10-introspect`)
are in. Still to do before `built`: one run with a real `pg_dump` — the engine's live spec
(`INTROSPECT_TEST_URL=… pnpm --filter @schemaloom/engine-postgresql test`) and workflow 10 —
plus building the api image once to confirm the PGDG `postgresql-client` install.

## Known gaps in built features

Small fixes that don't need a design doc. Pick one up freely.

- The web shows a generic error for `423` (project on an old engine major). It should say
  "read-only until an operator upgrades the engine".
- A signed-in user who opens a share link sees their own account's view, not the link's
  (`sl_access` wins in `JwtAuthGuard`).
- Area-scoped export is still deferred (Q29).
