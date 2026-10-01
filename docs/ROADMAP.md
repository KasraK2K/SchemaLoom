# SchemaLoom roadmap

This is the single list of what is built, what comes next, and in what order. It is for human
contributors and AI agents alike. Last updated 2026-09-30.

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

| #   | Feature                                             | Status   | Design                             | Why it matters                                                                                                 |
| --- | --------------------------------------------------- | -------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 6a  | **Import a project from a live database**           | `built`  | `docs/phase6/DESIGN.md` §1–§5      | Most users already have a database. Redrawing it by hand is where they give up.                                |
| 6b  | **Drift check: design vs. live database**           | `built`  | `docs/phase6/DESIGN.md` §6         | "Production has 4 changes your design doesn't," plus the SQL to reconcile. The reason to come back every week. |
| 6c  | Saved connections (Sync now, Compare now)           | `built`  | `docs/phase6/SAVED-CONNECTIONS.md` | Sync and compare later without re-typing credentials. Scheduled checks and alerts follow as 6d.                |
| 7   | ORM round-trip: Prisma export first, then import    | `idea`   | —                                  | For many teams the ORM file is the source of truth. An exporter plugs into the existing exporter contract.     |
| 8   | Drizzle / TypeORM / Django exporters                | `idea`   | —                                  | Same contract as 7. Build only the ones users ask for.                                                         |
| 9   | Second engine: MySQL / MariaDB                      | `idea`   | —                                  | Roughly doubles the market. The engine boundary is built for this. Wait until 6a–6b are proven on PostgreSQL.  |
| 10  | Schema change requests (propose → review → merge)   | `idea`   | —                                  | PR-style review for schema edits, on top of comments, history and migrations. What teams pay for.              |
| 11  | CLI + CI: `schemaloom pull`, `diff --fail-on-drift` | `idea`   | —                                  | Puts SchemaLoom in the deploy pipeline. Reuses 6b's drift endpoint with an API token.                          |
| 12  | First-run experience: sample projects, templates    | `idea`   | —                                  | A new user currently lands on an empty canvas.                                                                 |
| 13  | SQLite engine                                       | `idea`   | —                                  | Cheap second or third engine, popular with indie developers.                                                   |
| 14  | Enterprise: SAML/OIDC SSO, audit log viewer         | `parked` | —                                  | Wait until a paying customer asks. The audit log data already exists.                                          |
| 15  | Remaining Phase 3 login paths (magic link, TOTP…)   | `parked` | `docs/phase1/00-OVERVIEW.md` Q28   | Cut on purpose in Q28. Additive when needed.                                                                   |

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

- The web shows a generic error for `423` (project on an old engine major). It should say
  "read-only until an operator upgrades the engine".
- A signed-in user who opens a share link sees their own account's view, not the link's
  (`sl_access` wins in `JwtAuthGuard`).
- Area-scoped export is still deferred (Q29).
