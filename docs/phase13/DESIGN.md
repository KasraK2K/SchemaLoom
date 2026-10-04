# Phase 13: SQLite engine

Status: **approved 2026-10-04** with every default in the open-questions table, and **built**
2026-10-04. Roadmap row 13.

**As built**, where it differs from the text below:

- **Upload routes (§5):** separate routes, `POST …/introspect/upload/preview` and
  `…/introspect/upload/drift`, take the file as a raw `application/octet-stream` body (no
  multipart parser). Same marker and the same full-view check before the bytes are read.
- **Cap (§5, Q4):** the variable is `INTROSPECT_UPLOAD_MAX_BYTES` (default 100 MB), named
  for the route rather than the engine.
- **Namespaces:** `none`, not a single `main` schema. Attached databases are out of scope.
- **`CREATE TABLE … AS SELECT`** is refused at import with a message. It is never executed,
  so the importer's allowlist stays DDL only.
- **Foreign key names** are not preserved. SQLite's `foreign_key_list` doesn't report them,
  so the importer names each one `<table>_<columns>_fkey`.
- **Build gotcha:** tsup strips the `node:` prefix by default, and `node:sqlite` has no
  unprefixed name. The engine's `tsup.config.ts` sets `removeNodeProtocol: false`.
- **No e2e workflow** for the upload. The api specs and the engine's conformance suite cover it.
  The third engine, after PostgreSQL and MySQL/MariaDB (`docs/phase9/DESIGN.md`, whose structure
  this follows).

Decided with the owner before writing (2026-10-04): **live reading is by uploading a `.db`
file.** There is no server to connect to, so there are no saved connections, scheduled drift
checks or CLI drift for SQLite. Every ORM export (row 8) applies from day one.

## 1. What "done" means

A SQLite project can do everything a PostgreSQL project can, except what needs a server:

| Feature                                                    | SQLite                                    |
| ---------------------------------------------------------- | ----------------------------------------- |
| Canvas, docs, sharing, history, change requests, templates | yes (engine-neutral already)              |
| SQL import / export (`.sql`)                               | yes                                       |
| Prisma, Drizzle, TypeORM, Django export; Prisma import     | yes (rows 8 and 7b)                       |
| Migration SQL (history and drift)                          | yes, with SQLite's table rebuild (§4.4)   |
| Saved queries, query validation, AI assistant (all modes)  | yes                                       |
| Import from database, Compare (drift)                      | yes, **by uploading the `.db` file** (§5) |
| Saved connections, scheduled drift checks, CLI `diff`      | no: there is nothing to reconnect to      |

## 2. The decisions in one paragraph

SQLite is its own parser: the engine runs SQL in an **in-memory SQLite database** through
Node's built-in `node:sqlite` and reads the result back with `PRAGMA`s, instead of parsing DDL
by hand. That makes import exact (SQLite decides what a statement means), adds no package the
workspace doesn't already have, and gives query validation for free (`prepare` against the design's own
schema). Only an allowlist of statement kinds is ever executed (§4.1), because SQLite can touch
the file system (`ATTACH` creates a file; checked 2026-10-04).

## 3. How SQLite maps onto the IR

| SQLite                                                             | IR                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the database (`main`)                                              | one namespace, `main`, not creatable or renamable. Attached databases are out of scope                                                                                                                                                                                          |
| table, `WITHOUT ROWID`, `STRICT`                                   | entity `table`; the two flags are engine props                                                                                                                                                                                                                                  |
| view                                                               | entity `view` with `viewDefinition` (drift's `sameViewBody` gets a SQLite version)                                                                                                                                                                                              |
| column type                                                        | **the declared type, as written** (`varchar(255)`, `datetime`, `INTEGER`). The type catalog lists the common ones and their affinity; any other name is accepted, because SQLite accepts any name. A `STRICT` table allows only `INT`, `INTEGER`, `REAL`, `TEXT`, `BLOB`, `ANY` |
| `INTEGER PRIMARY KEY` (rowid alias), `AUTOINCREMENT`               | primary key; `AUTOINCREMENT` is a field prop                                                                                                                                                                                                                                    |
| `DEFAULT`, `GENERATED ALWAYS AS (…) STORED/VIRTUAL`, `COLLATE`     | field props, as for the other engines                                                                                                                                                                                                                                           |
| `CHECK`, `UNIQUE`, `PRIMARY KEY`, `FOREIGN KEY … ON DELETE/UPDATE` | constraints                                                                                                                                                                                                                                                                     |
| index, unique index, partial index (`WHERE`), expression index     | index                                                                                                                                                                                                                                                                           |
| enum                                                               | **none.** SQLite has no enum type; `TEXT CHECK (x IN (…))` stays a CHECK constraint                                                                                                                                                                                             |
| triggers, virtual tables (FTS5, R*Tree)                            | `unsupported` on import, with the reason; not modelled                                                                                                                                                                                                                          |
| docs                                                               | SQLite has no `COMMENT`; docs live in SchemaLoom only, and the export writes them as `--` comments                                                                                                                                                                              |

## 4. The engine package, service by service

`packages/engines/sqlite`, id `sqlite`, displayed "SQLite". A `./static` entry for the browser,
like the other two, holding capabilities, type catalog, terminology, props schemas and
`normalizeName` (SQLite names are case-insensitive for ASCII: fold to lower case for identity,
keep the spelling for display).

### 4.1 Importer (`ddl`)

1. Split the source into statements with a scanner that knows quotes, comments and
   `BEGIN … END` (trigger bodies), like MySQL's `sql-scan.ts`.
2. Classify each statement by its leading keywords. **Executed:** `CREATE TABLE` (including
   `AS SELECT`, reported `partial`: data isn't copied), `CREATE [UNIQUE] INDEX`, `CREATE VIEW`,
   `ALTER TABLE … ADD/RENAME/DROP COLUMN`, `ALTER TABLE … RENAME TO`, `DROP …`.
   **Never executed:** everything else. `PRAGMA`, `BEGIN`, `COMMIT`, `INSERT`, `ANALYZE` are
   `ignored`; `CREATE TRIGGER` and `CREATE VIRTUAL TABLE` are `unsupported`; anything not
   recognised (including `ATTACH`, `VACUUM INTO`, `load_extension`) is `failed` ("not part of a
   schema"). This allowlist is the security boundary, and it gets its own tests.
3. Execute the allowed statements in order in a fresh `:memory:` database (extensions off,
   which is `node:sqlite`'s default). SQLite's error for a statement becomes that statement's
   `failed` reason, verbatim.
4. Read the model back: `sqlite_schema`, `PRAGMA table_xinfo`, `foreign_key_list`,
   `index_list`, `index_xinfo`. **CHECK bodies are the one thing PRAGMAs don't return**: they're
   cut from the stored `CREATE TABLE` text by the same scanner (balanced parentheses after
   `CHECK`).
5. Track which statement produced which object, for the report.

### 4.2 Exporter (`ddl` and the four ORMs)

- `ddl`: `CREATE TABLE` with inline constraints (SQLite can't add a constraint later), then
  `CREATE INDEX`, then `CREATE VIEW` in dependency order. Docs become `--` comments when
  comments are on. `IF NOT EXISTS` is supported; drops are `DROP … IF EXISTS`.
- ORMs: `orm-types.ts` with the SQLite `OrmDialect` (Prisma `sqlite`, Drizzle `sqlite-core`,
  TypeORM `sqlite`, Django's default fields).

### 4.3 `annotateDiff`

As MySQL's: removed tables and columns are destructive; a type change is `lossy` only when the
**affinity** changes (`varchar(50)` → `text` keeps TEXT affinity, so it's safe).

### 4.4 Migration generator

SQLite's `ALTER TABLE` can only add, rename and drop a column and rename a table. Everything
else (a type, nullability, default, constraint or foreign key change) uses SQLite's documented
**table rebuild**:

```sql
PRAGMA foreign_keys = OFF;
BEGIN;
CREATE TABLE "orders__new" (…the target definition…);
INSERT INTO "orders__new" ("id", "total") SELECT "id", "total" FROM "orders";
DROP TABLE "orders";
ALTER TABLE "orders__new" RENAME TO "orders";
-- recreate the table's indexes and dependent views
PRAGMA foreign_key_check;
COMMIT;
PRAGMA foreign_keys = ON;
```

DDL is transactional in SQLite, so `transactional=true` wraps the whole plan. A rebuild that
drops a column, or narrows a `STRICT` type, is destructive and commented out unless
`allowDestructive`, like every engine.

### 4.5 Query validator

The redacted design's DDL is loaded into a `:memory:` database (the exporter's own output,
which also checks the exporter), and the query is `prepare`d there: SQLite reports unknown
tables and columns exactly. Touched entities and fields come from walking the query with
`node-sql-parser`'s `sqlite` dialect (already in the workspace catalog for MySQL). When that
parser fails on valid SQLite, touched ids fall back to every visible entity named in the
query's text, a superset, which is the safe direction for L25. No probe (L13): validation
never reads data, and there is no data.

### 4.6 AI profile and templates

The same `serializeContext` shape as the other engines, a system prompt for SQLite's dialect
(no `RIGHT JOIN` before 3.39, dates as text, `||` for concatenation), and every mode. Two
templates: a todo app and a blog, small enough to read on the first screen.

## 5. Reading a `.db` file (the only change to how core reads databases)

- **Capabilities:** `introspection: 'network' | 'file' | 'none'` (PostgreSQL and MySQL are
  `network`). SQLite declares `file` and no `connectionFields`.
- **Routes:** `POST /projects/:projectId/introspect/preview` and `…/drift` accept a multipart
  upload (`file`) when the engine is `file`. Same marker (`schema:edit`), same full-view check
  (R21′) **before the file is read**, same response.
- **Reading:** the upload goes to a temporary file, is opened with `readOnly: true`, and only
  `SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`
  runs: never a row of user data. The result is DDL text in the engine's `ddl` format, so it
  goes through the normal import pipeline (introspection produces source, not IR, Phase 6 §1).
  The file is deleted in a `finally`. `serverVersion` is the SQLite version that last wrote the
  file (its header, bytes 96–99).
- **Limits:** the upload cap is `SQLITE_UPLOAD_MAX_BYTES` (default 100 MB). Over it, the
  dialog suggests the alternative that always works: `sqlite3 app.db .schema`, pasted into the
  SQL import.
- **Refused for file engines:** saved connections and schedules (`400
connection.not_supported`), and the CLI's `diff` (it already requires a saved connection,
  Phase 11 Q4). The web hides those controls when the engine is `file`.
- **Address guard:** not involved. There is no host to resolve, so the SSRF guard has nothing
  to check, and `INTROSPECTION_ENABLED=false` still turns the upload off.

## 6. Delivery

1. Static facet, type catalog, importer and DDL exporter; conformance passes. A project can be
   created and imported from SQL.
2. `annotateDiff` and the migration generator (rebuilds), checked by applying generated
   migrations to real SQLite files.
3. Query validator and AI profile.
4. `.db` upload for import and Compare (§5), and `sameViewBody`.
5. ORM types (row 8's dialect) and templates.

## 7. Tests

- **Conformance:** the full engine suite, as for MySQL.
- **Importer:** the allowlist (each refused kind is reported and never executed: `ATTACH`
  leaves no file behind); a fixture covering every row of §3; CHECK extraction with nested
  parentheses and strings.
- **Migrations, for real:** for each history fixture, apply the old DDL to a temp file, run the
  generated migration, then introspect and diff against the target: empty. This covers the
  rebuild path, foreign keys and dependent views.
- **Upload:** the route reads the schema, never a row (a table with rows gives the same
  source as an empty one); the temp file is gone afterwards, on success and on error; a
  non-SQLite file is a readable 422.
- **e2e:** one SQLite workflow: create from a template, upload a `.db`, compare, export Drizzle.

## 8. Open questions

| #   | Question                      | Default                                                                                                                                                                                          |
| --- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | SQLite library                | **`node:sqlite`** (built into Node, no new dependency). It still prints an "experimental" warning; the engine wraps it in one file, so swapping in `better-sqlite3` is one file if its API moves |
| Q2  | Minimum Node                  | **22.13** (`node:sqlite` without a flag). `package.json` `engines` moves from 22.12; the Docker image is already a newer 22                                                                      |
| Q3  | Column types                  | **The declared name, kept as written.** Rewriting `varchar(255)` to `TEXT` would make a design differ from the database it came from                                                             |
| Q4  | Upload size cap               | **100 MB**, `SQLITE_UPLOAD_MAX_BYTES`. Most app databases are smaller; for bigger ones, `.schema` and paste                                                                                      |
| Q5  | Attached databases (`ATTACH`) | **Out of scope.** One database, one namespace                                                                                                                                                    |
| Q6  | Triggers and virtual tables   | **Reported `unsupported`**, like triggers on the other engines                                                                                                                                   |
| Q7  | Target versions               | **3.35+** (`DROP COLUMN`, `RETURNING`), listed as `3.45`, `3.40`, `3.35`; the generator never emits newer syntax                                                                                 |
