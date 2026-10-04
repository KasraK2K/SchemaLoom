# Phase 7b: Prisma import

Status: **approved 2026-10-04** with every default in the open-questions table. Roadmap row 7b.
Builds on the shared ORM layer (`docs/phase8/DESIGN.md` §2.1), so it lands after row 8's
first step.

## 1. What the user sees

The import dialog accepts a `schema.prisma` as well as SQL: drop or pick the file, or paste it.
The dialog notices it's Prisma (by the `.prisma` extension, or a `datasource`/`model` block when
pasted) and says so. From there everything is the SQL import as it is today: the same preview
("creates 4 tables, 2 already exist"), the same rename confirmation, the same report of what
couldn't be applied, and the same **additive merge**, so existing objects win and nothing is
deleted (CLAUDE.md: changing that is a product decision).

`///` comments become docs, the way `COMMENT ON` does for SQL (`docs/phase12/DESIGN.md` §5):
only for new objects and objects with no doc yet, and only when the caller has `docs:edit`.

**The file's `provider` must match the project's engine.** `postgresql` imports into a
PostgreSQL project, `mysql` into MySQL/MariaDB, `sqlite` into SQLite. Anything else is refused
with a plain reason ("This file is for MySQL; the project is PostgreSQL").

## 2. How it works

### 2.1 Parsing: Prisma's own parser

`@prisma/prisma-schema-wasm` is the parser and validator `prisma` itself uses (WASM, no native
binary, no database). Its `get_dmmf` returns the validated data model: models with `dbName`,
fields with `nativeType` (`["VarChar", ["255"]]`), `default`, `isId`, `isUnique`,
`isUpdatedAt`, relations with `relationFromFields`/`relationToFields`/`relationOnDelete`,
composite `primaryKey`, `uniqueIndexes`, `indexes`, enums, and `documentation` (the `///`
text). A file Prisma rejects is rejected with Prisma's own error message.

It loads lazily on the server only, the way `libpg-query` does (`parser.ts`'s dynamic import),
so no browser bundle ever sees it.

### 2.2 Mapping: the export's table, in reverse

The importer lives in `packages/orm` (`importPrisma(source, ctx, dialect)`) and reads the same
`OrmDialect.types` table the export writes from. For each field, it finds the engine type whose
`prisma` entry has that scalar and native type. A scalar with no `@db.*` takes the entry Prisma
treats as the default (`String` → `text` on PostgreSQL, `varchar(191)` on MySQL). Because export
and import share one table, a round trip (export, then import into an empty project) gives the
same design back, and that's the main test.

| Prisma                                                 | Design                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `model` (`@@map`)                                      | table, named by `@@map` when present                                                           |
| field (`@map`), `?`                                    | column, nullable when optional                                                                 |
| `@db.*` / scalar                                       | the engine type from the shared table                                                          |
| `Unsupported("…")`                                     | the engine type named in the string, read with the engine's type parser                        |
| `@default(autoincrement())`                            | serial / identity / `AUTO_INCREMENT` / `AUTOINCREMENT`, as the engine spells it                |
| `@default(now())`, `dbgenerated("…")`, literals        | the database default                                                                           |
| `@default(cuid())`, `uuid()`, `nanoid()`, `@updatedAt` | **no default**, reported `partial`: Prisma Client fills these in, the database never sees them |
| `@id`, `@@id`                                          | primary key, with `map:` as its name                                                           |
| `@unique`, `@@unique`                                  | unique constraint                                                                              |
| `@@index` (`type: Gin`, …)                             | index, with its method                                                                         |
| `@relation(fields, references, onDelete, onUpdate)`    | foreign key on the side holding `fields`, named by `map:` or Prisma's default                  |
| relation-only fields (back-relations, implicit m-n)    | nothing for back-relations; an **implicit many-to-many** becomes its `_AToB` join table        |
| `enum`                                                 | enum type (PostgreSQL), inline enum (MySQL), `TEXT` + `CHECK` (SQLite)                         |
| `@@schema("x")`                                        | the namespace (PostgreSQL)                                                                     |
| `view` blocks (preview feature)                        | `unsupported`: a Prisma view has no body to import                                             |
| `@@ignore`, `@ignore`                                  | imported anyway: they describe Prisma Client, not the database                                 |
| `///` comments                                         | docs (§1)                                                                                      |

### 2.3 "Account for every statement"

The importer contract (doc 03 §9) needs one report row per statement with a source range. For
Prisma a statement is a **top-level block**: `datasource`, `generator`, each `model`, `enum`,
`view` and `type`. A small block scanner finds each block's range (braces, strings and comments
aware). `datasource` and `generator` are `ignored`; `type` (MongoDB composite types) is
`unsupported`; a model with a dropped default is `partial` with the reason.

### 2.4 Changes outside `packages/orm`

- **Engines** add `{ id: 'prisma', displayName: 'Prisma schema', fileExtensions: ['.prisma'] }`
  to `importFormats`, after `ddl`, and their importer switches on `options.format`.
- **Core picks the format.** Today core always uses `importFormats[0]`. The import and preview
  routes take an optional `format`, validated against the engine's `importFormats`, defaulting
  to the first one. Introspection, drift and AI draft-schema keep using `ddl`.
- **Web:** the import dialog sends `format: 'prisma'` when it detects Prisma, accepts `.prisma`
  files, and shows "Prisma schema" in the dialog's heading.

## 3. Tests

- **Round trip**, per engine: the Phase 8 fixture exported as Prisma and imported into an empty
  model gives the same tables, columns, types, keys, indexes and foreign keys.
- **Real files:** `prisma db pull` output from the live PostgreSQL, MySQL and SQLite test
  databases imports with no `failed` rows.
- **Report:** every block accounted for; `cuid()` reported `partial`; a provider mismatch and a
  file Prisma rejects both give one `failed` row with a readable reason.
- **Merge:** importing over an existing project adds only what's new (the SQL import's
  merge tests, run with a Prisma source).
- **e2e:** one workflow step imports a `schema.prisma` through the dialog.

## 4. Open questions

| #   | Question                                    | Default                                                                                                                                    |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Q1  | Parser                                      | **`@prisma/prisma-schema-wasm`**, pinned to the version the api's `prisma` uses. Prisma's own validation, no hand-written grammar to drift |
| Q2  | App-level defaults (`cuid()`, `@updatedAt`) | **Dropped and reported `partial`.** The design is the database; the report says Prisma Client fills them in                                |
| Q3  | Implicit many-to-many                       | **Create the `_AToB` join table** Prisma would create, so the design matches the database                                                  |
| Q4  | Merge behaviour                             | **Additive, existing wins**, like SQL import. Not reopened here                                                                            |
| Q5  | "New project from schema.prisma"            | **Yes, for free**: project creation already offers "start from an import", which uses the same dialog                                      |
| Q6  | Prisma `view` blocks                        | **`unsupported`**: they have no SQL body. A view imported from SQL keeps working                                                           |
