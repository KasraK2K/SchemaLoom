# Second engine: MySQL / MariaDB (roadmap 9)

Status: **approved** 2026-10-02 with every default in §10. **9a–9d built** the same day.

**As built (9a):**

- **Parser spike result: `node-sql-parser` works** (Q2's default holds), with a small pre-pass in
  `sql-scan.ts`. mysqldump's `/*!50001 … */` version comments are unwrapped first: the parser
  drops them as comments, which would lose every view in a dump. `PARTITION BY` is stripped
  and the statement reported `partial`. `SRID n`, a column's `INVISIBLE` and a CHECK's
  `NOT ENFORCED` are read off the text, then removed. `DOUBLE PRECISION` is spelt `DOUBLE`.
  Each statement is parsed with the target's dialect first, then the other: the MariaDB
  grammar knows `uuid`, the MySQL one some `ALTER` forms MariaDB's lacks.
- **Comments.** MySQL has no `COMMENT ON`, so the exporter writes a table's doc as
  `ALTER TABLE … COMMENT = '…'` and a column's as `ALTER TABLE … MODIFY COLUMN <definition>
COMMENT '…'` (the only way MySQL comments one column). The importer reads that idiom back
  as a doc. Inline `COMMENT '…'` in `CREATE TABLE` imports as docs too.
- **Name scope (§5.1).** PostgreSQL validator diagnostics are advisory, so a duplicate index
  name across two PostgreSQL tables is now an error diagnostic rather than a 422 refusal.
  The store enforces names per table.
- **The pg_dump hint (§5.4)** was made tool-neutral rather than moved into the engine. Only an
  introspector that shells out throws `not_available`, and MySQL's doesn't.
- **Default engine.** `GET /engines` now lists available engines in manifest order instead of by
  name, so the deployment's first engine (PostgreSQL) stays the picker's default. Sorted by name,
  "MySQL / MariaDB" would have become every new project's default.
- **Target versions** name their product (`MariaDB 11.4`), and the picker shows them as they are.
- **Real servers.** A `mysql` compose profile adds MySQL 8.4 and MariaDB 11.4. Pulling images
  from Docker Hub was blocked (403) from this network on 2026-10-02, so 9a is verified against
  canonical `SHOW CREATE TABLE` / mysqldump text, the conformance round trip and e2e workflow
  15, not yet against live servers.

**As built (9b, live database):** `introspector.ts`. The socket is dialled to the address
core's SSRF guard checked, and mysql2 gets the typed host name, so TLS verifies the
certificate against the name. SSL modes use MySQL's own words (`REQUIRED`, `VERIFY_IDENTITY`,
`VERIFY_CA`, `DISABLED`, the last declared insecure). `PREFERRED` is not offered, because
it falls back to plain text without saying so. The session is set to read-only with
`sql_mode = ''`, so `SHOW CREATE` uses backticks. Verified against MySQL 8.4 and MariaDB
11.4 containers (Docker Hub was reachable this time): a round trip (export, run on the
server, read back, import, export again) in `introspector.spec.ts`, and e2e workflow 15
(read, import, no drift, add a column, drift). The round trip found:

- MariaDB refuses `NULL` on a generated column, so the exporter writes nullability there only
  for `NOT NULL`.
- MariaDB has no functional key parts: a new validator error for MariaDB targets.
- The two servers spell the same column differently: a quoted or bare numeric default,
  `CURRENT_TIMESTAMP` with or without `()`, `lower` or `lcase`, `CHARACTER SET` repeated
  next to a `COLLATE` that already names it, and `ON DELETE RESTRICT` (the default) written
  or left out. The importer reads both spellings the same way, or an unchanged database
  would read as drift.
- MariaDB rewrites view bodies. That is still a known gap (ROADMAP).
- Core drift compared docs, PII flags and store defaults. Fixed for every engine
  (`withDesignOnly`, and `mergeImport` gives imported objects the stored form).

**As built (9c, migrations):** `migration.ts` and `annotate.ts`. Renames run first (`RENAME
TABLE`, `RENAME COLUMN`, `RENAME INDEX`), then drops (foreign keys first), then `MODIFY COLUMN`
with the whole definition, then creates (`CREATE TABLE` with keys inline, `ADD COLUMN … AFTER`),
then keys, indexes and foreign keys. A column renumbered by a neighbour's add or drop is covered
by that step; a real reorder becomes `MODIFY COLUMN … AFTER`. `transaction` is always null, and
the first statement is preceded by a comment saying the script cannot be rolled back. A CHECK is
dropped with `DROP CHECK` on MySQL and `DROP CONSTRAINT` on MariaDB.

**As built (9d, queries and AI):** `query-validator.ts` resolves tables, aliases, CTE names and
columns from node-sql-parser's AST against the caller's redacted model, with one name scope per
statement (a `ponytail:` note says how to go per subquery). The MariaDB grammar gives tables no
location and pads a column's location with the following space, so ranges are trimmed and a
missing one is found in the query text. `ai-profile.ts` is the PostgreSQL profile with MySQL
prompts, backtick quoting and no schema (`N`) lines.

**Templates (roadmap 12, for MySQL):** `templates.ts` ships the same three starting schemas as
the PostgreSQL engine (E-commerce, SaaS, Blog), written the MySQL way, with every table and the
key columns documented through inline `COMMENT '…'`.

## 1. Why now, and what "done" means

PostgreSQL is the only engine. The engine boundary (doc 03) was built so a second one is "a
package plus four lines in the apps" (doc 03 §18), but nothing has tested that claim yet.
MySQL and MariaDB are the obvious second engine: they roughly double who can use SchemaLoom,
and the roadmap's condition (6a/6b proven on PostgreSQL) was met on 2026-09-30.

**Done** means a MySQL or MariaDB user gets everything a PostgreSQL user gets today:

- draw a schema, or import it from SQL or a live database
- export DDL, and check drift against the live database
- generate migration SQL
- validate saved queries, and ask the AI assistant

All of this has to pass the full conformance suite and an e2e run against real MySQL and
MariaDB servers.

## 2. The decisions in one paragraph

**One engine, `mysql`, covers both MySQL and MariaDB.** The target version picker says which:
`MySQL 8.4`, `MySQL 8.0`, `MariaDB 11.4`, `MariaDB 10.11`. The engine models the large common
subset, and the validator flags the few version differences. A **project models one database**,
so the engine has no namespaces. **Reading a live database uses a Node driver** (`mysql2`) and
`SHOW CREATE TABLE` instead of a dump tool, so the api image needs no new client binary. The
DDL goes through the same importer as pasted SQL. **It ships in four steps**: design and
export, then live database and drift, then migrations, then queries and AI. Each step is
usable on its own and passes conformance, because the SDK already lets an engine leave a
feature off until it is built.

## 3. How MySQL maps onto the IR

Nothing here needs a new IR concept. Everything MySQL-specific lands in `engineProps` (C4).

| MySQL reality                                                                                                                                                     | In SchemaLoom                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A "database" is the whole schema; DDL rarely names it                                                                                                             | `namespaces: 'none'`. A project is one database. Cross-database foreign keys are out of scope (§9).                                                               |
| Tables and views                                                                                                                                                  | Entity kinds `table` and `view`. There are no materialized views.                                                                                                 |
| InnoDB foreign keys                                                                                                                                               | Link kind `foreignKey`, enforced, with `ON DELETE` and `ON UPDATE` actions.                                                                                       |
| Inline `ENUM('a','b')` and `SET(...)` column types                                                                                                                | Ordinary types whose allowed values sit in `TypeRef.args`, which already accepts strings. No custom types (`customTypeKinds: []`).                                |
| `INT UNSIGNED`, `AUTO_INCREMENT`, `ON UPDATE CURRENT_TIMESTAMP`, `CHARACTER SET` and `COLLATE` per column, generated columns (`VIRTUAL` or `STORED`), `INVISIBLE` | Field `engineProps`.                                                                                                                                              |
| `ENGINE=InnoDB`, `DEFAULT CHARSET`, `COLLATE` and `ROW_FORMAT` per table                                                                                          | Entity `engineProps`. `AUTO_INCREMENT=` (the counter's next value) is dropped on import: it describes data, not schema.                                           |
| B-tree, `FULLTEXT` and `SPATIAL` indexes; prefix lengths `col(10)`; functional key parts (MySQL 8.0.13+)                                                          | Index types `btree`, `fulltext` and `spatial`. The prefix length is an index-column prop. `expressionIndexes: true`, `includeColumns: false`, no partial indexes. |
| `PRIMARY KEY`, `UNIQUE`, `CHECK` (enforced since MySQL 8.0.16 and MariaDB 10.2)                                                                                   | Constraint kinds `primaryKey`, `unique` and `check`.                                                                                                              |
| `COMMENT '...'` on a table or column (inline, not `COMMENT ON`)                                                                                                   | Imported as docs through `ImportResult.docs`, built 2026-10-02. Exported inline from the doc excerpt (`features.comments: true`).                                 |
| Identifiers: 64 characters, quoted with backticks                                                                                                                 | `identifiers.maxLength: 64`, backtick quoting, MySQL's reserved-word list.                                                                                        |
| Table name case depends on the server's `lower_case_table_names`; column names are always case-insensitive                                                        | **Case-insensitive, spelling preserved** (`foldsTo: 'none'`, `caseSensitive: false`). See Q3.                                                                     |

## 4. The engine package, service by service

New packages `packages/engines/mysql` and `packages/engines/mysql-ui`, with the same layout
as the PostgreSQL pair.

| Service                                                     | Approach                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Parser**                                                  | `node-sql-parser` (pure JS, with MySQL and MariaDB dialects) for DDL and queries. **First task: a one-day spike** that parses real `SHOW CREATE TABLE` and `mysqldump --no-data` output from MySQL 8.0 and 8.4 and MariaDB 10.11 and 11.4, plus the conformance fixtures. If coverage is poor, the fallback is a small hand-written DDL parser: `SHOW CREATE` output is very regular. See Q2.                                                                          |
| **Importer**                                                | Statement split, then parse, then build the model, exactly as the PostgreSQL importer does, with the same rule that every statement is accounted for. Triggers, routines, events, `CREATE USER`/`GRANT`, `SET` and `LOCK TABLES` are reported `ignored` or `unsupported`, each with a reason. Partitioning is `partial` (the table imports without it).                                                                                                                |
| **`extractReferences`** (required by the permission system) | Walks CHECK bodies, defaults, generated-column expressions and functional index parts. **Fails closed:** an expression it cannot parse references every field of its entity, so it is redacted rather than leaked (doc 03 §3.1).                                                                                                                                                                                                                                       |
| **Validator**                                               | MySQL's real rules: 64-character names; one `AUTO_INCREMENT` column per table, and it must be indexed; foreign-key columns must match in type, signedness, charset and collation; `TEXT`/`BLOB` in an index needs a prefix length; the InnoDB key length limit (3072 bytes); the index name `PRIMARY` is reserved; index names must be unique per table. Version-gated warnings, for example the `UUID` type on MySQL (MariaDB 10.7+ only).                            |
| **Exporter**                                                | `CREATE TABLE` with inline `COMMENT`s, then foreign keys as `ALTER TABLE … ADD CONSTRAINT` so cycles work, using the same phase ordering contract as PostgreSQL (doc 03 §10.1). Redaction is honoured exactly as today.                                                                                                                                                                                                                                                |
| **Introspector**                                            | `mysql2` over the address core's SSRF guard resolved, read-only (`SET SESSION TRANSACTION READ ONLY`). It lists objects from `information_schema.TABLES`, then concatenates `SHOW CREATE TABLE` and `SHOW CREATE VIEW` for each one. The server version comes from `SELECT VERSION()`, which also says whether it is MariaDB. TLS uses the CA and client certificate fields; the SSH tunnel is core's, unchanged. Errors map onto the existing `IntrospectErrorCode`s. |
| **Migration generator**                                     | `ALTER TABLE … ADD`, `MODIFY COLUMN` (MySQL needs the whole column definition), `RENAME COLUMN` (MySQL 8.0+, MariaDB 10.5+), `ADD`/`DROP INDEX`, `ADD`/`DROP FOREIGN KEY`. **DDL is not transactional in MySQL**: the script says so at the top, and the "wrap in a transaction" option is not offered. Destructive steps are flagged with the same `AnnotatedDiff` rules.                                                                                             |
| **Query validator**                                         | Parses `SELECT` with the same parser, resolves table and column names against the caller's redacted model, and reports hidden objects the way the PostgreSQL one does (doc 03 §12.1).                                                                                                                                                                                                                                                                                  |
| **AI profile**                                              | The SCS serialiser plus MySQL prompts and output instructions. Mostly shared shape with PostgreSQL, with dialect text swapped.                                                                                                                                                                                                                                                                                                                                         |
| **Prisma export**                                           | `provider = "mysql"`, reusing the PostgreSQL engine's approach. See Q6: default **later**, not in v1.                                                                                                                                                                                                                                                                                                                                                                  |
| **UI package**                                              | The facet; a type picker with `UNSIGNED`, length and `ENUM` value editing; field and table property sections (charset, collation, auto-increment, on-update); badges; and MySQL syntax highlighting through `loadEditorLanguage`.                                                                                                                                                                                                                                      |

## 5. Changes outside the engine (the boundary, tested)

A survey of core found it mostly engine-neutral: no `engineId ===` branching anywhere, and
capabilities drive the UI. Four things do assume PostgreSQL and have to change **first, as
their own small commit, with PostgreSQL behaviour unchanged**:

1. **Name uniqueness in the store.** Migration 0002 makes index and constraint names unique
   across the whole project (`indexes_name_uq`, `constraints_name_uq`). In MySQL, index names
   are unique only per table, so `idx_user_id` on several tables (common) and every primary key
   (always named `PRIMARY`) fail with `duplicate_name`. The fix: a migration that scopes both
   indexes to the entity (`entity_id, lower(name)`). The PostgreSQL validator then takes over
   the schema-wide rule as an error diagnostic, so PostgreSQL users see the same refusal they
   do today. Entity and field name indexes stay as they are (see Q3).
2. **The TLS guard** (`apps/api/src/introspect/connection.ts`) refuses an unencrypted
   connection only when it sees `sslmode === 'disable'`, which is PostgreSQL's vocabulary. A
   MySQL "TLS off" value would slip past it. The fix: `ConnectionField` gains an optional
   `insecureValues: string[]`, and the guard checks the field whose values are declared that
   way. PostgreSQL declares `['disable']`, so its behaviour doesn't change. This is a security
   control, so it gets its own test.
3. **The web UI contract** lives in `@schemaloom/engine-postgresql-ui/contract`, so a MySQL UI
   package would have to depend on the PostgreSQL one. It moves to `@schemaloom/engine-sdk/ui`,
   where `EngineStaticFacet` already is. That's a type-only move.
4. **Small wiring:**
   - `apps/web/package.json`, `next.config.ts` `transpilePackages` and `register.ts` gain the
     MySQL lines.
   - `apps/api/package.json` and `engines.manifest.ts` gain one line each.
   - The `pg_dump` hint shown for `not_available` comes from the engine instead of being
     hard-coded in `introspect.service.ts`.
   - The connection placeholder `postgres://…:5432` comes from the engine's fields.

Nothing changes in `schema`, `access`, `snapshots`, `docs`, `ai`, `realtime`, the canvas or the
inspector. That is the doc 03 §18 claim, and the PR should show it.

## 6. Delivery in four steps

Each step is a merge on its own. Conformance already checks that `features.*` matches the
services present, so an unfinished service is simply switched off.

| Step   | Ships                                                                                        | A user can…                                                                            |
| ------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **9a** | §5's core changes; static facet, types, props, references, validator, importer, exporter, UI | Create a MySQL project, draw it or import SQL, and export DDL.                         |
| **9b** | Introspector                                                                                 | Read a live MySQL or MariaDB database, Sync, and run drift checks (scheduled too, 6d). |
| **9c** | Migration generator, `annotateDiff`                                                          | Get migration SQL from history and drift.                                              |
| **9d** | Query validator, AI profile                                                                  | Validate saved queries and use the AI assistant.                                       |

The roadmap row splits the same way, `9a`–`9d`, each with its own status.

## 7. Tests

- **The conformance suite**, with MySQL fixtures: an e-commerce dump, an "every status" file,
  redacted models and migration pairs. It must pass at each step, with the unbuilt services
  skipped exactly as the SDK reports.
- **Round trip against real servers.** A `docker compose` profile adds MySQL 8.4 and MariaDB
  11.4, only for this test and not in `pnpm infra:up`. The test exports the DDL and runs it on
  the server, reads it back with the introspector, imports that, and checks the model is
  structurally equal. This is the check that catches dialect mistakes the parser alone can't.
- **Unit tests** for the validator rules, `extractReferences` failing closed, type mapping, and
  each `ignored` and `unsupported` reason.
- **Core:** the new name-scope migration (PostgreSQL still refuses a duplicate index name in a
  schema, MySQL accepts the same name on two tables), the `insecureValues` TLS guard, and the
  route and boot sweeps unchanged.
- **e2e workflow 15:** a MySQL project, then import SQL with inline comments, export, read the
  live MariaDB container, introduce a drift, and see the check report it.

## 8. Rollout

- `mysql` is already in `COMING_SOON`. The registration wins, so the picker starts offering it
  the moment 9a lands, with no change to that list.
- Existing PostgreSQL projects are unaffected. The name-scope migration only relaxes two
  indexes, and the PostgreSQL validator re-imposes the same rule.
- The Docker image is unchanged: the introspector is a JS driver.
- Docs: the README engine list, `docs/deploy.md` (MySQL needs no client tools), and a "MySQL
  notes" section on case sensitivity and non-transactional migrations.

## 9. Out of scope for v1

- Cross-database foreign keys and multi-database projects (`namespaces: 'none'`).
- Partitioning (imported as `partial`, and not exported), triggers, stored routines, events,
  users and grants.
- Storage engines other than InnoDB as first-class choices (`ENGINE=` is kept as a prop and
  exported, but nothing validates MyISAM's lack of foreign keys).
- Spatial types beyond carrying them through, and MariaDB-only features like system-versioned
  tables and sequences (reported `unsupported`).
- A separate MariaDB engine (Q1).
- Prisma export for MySQL (Q6). _Built 2026-10-04 with row 8 (`36d24ac`):_ MySQL exports
  Prisma, Drizzle, TypeORM and Django like every engine.

## 10. Open questions

| #   | Question                                     | Default                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | One engine for MySQL and MariaDB, or two?    | **One**, `mysql`, with the target version saying which. They share almost all DDL; the validator warns on the few differences. Split later only if they drift apart.                                                                                                                                                                |
| Q2  | Parser                                       | **`node-sql-parser`**, after the 9a spike against real dumps. Fallback: a hand-written DDL parser for `SHOW CREATE` output.                                                                                                                                                                                                         |
| Q3  | Name case                                    | **Case-insensitive, spelling kept.** This matches `lower_case_table_names=1` (Windows, macOS, most managed services) and keeps a schema portable. A Linux database with two tables differing only by case can't be imported; that statement is reported `failed` with the reason. It avoids changing core's single `NormalizeName`. |
| Q4  | Namespaces                                   | **`none`**: a project is one database. Reading a live database picks one database in the connection form.                                                                                                                                                                                                                           |
| Q5  | Live database: driver or `mysqldump`?        | **Driver** (`mysql2` + `SHOW CREATE`). No client binary in the image, and no version-matching problem like `pg_dump`'s.                                                                                                                                                                                                             |
| Q6  | Prisma export for MySQL in v1?               | **No**, a follow-up row once 9a–9d land. The PostgreSQL one took a day, and this one would reuse its structure.                                                                                                                                                                                                                     |
| Q7  | Which versions are offered?                  | MySQL **8.4** (default) and **8.0**, MariaDB **11.4** and **10.11**: the current LTS lines. MySQL 5.7 is end-of-life and not offered.                                                                                                                                                                                               |
| Q8  | Index and constraint name scope in the store | **Per entity** (§5.1), with the PostgreSQL validator enforcing its schema-wide rule, so PostgreSQL behaviour is unchanged.                                                                                                                                                                                                          |
| Q9  | Order of the four steps                      | **9a → 9b → 9c → 9d** as in §6. 9b next because drift is what brings people back every week.                                                                                                                                                                                                                                        |
