# Phase 7: Prisma export

Status: **approved 2026-10-01** with every default in §5, and **built** the same day. Roadmap row 7.

**As built:** primary-key columns are always required in the output, because an import of an
inline `PRIMARY KEY` leaves the field nullable and Prisma rejects `@id` on an optional field.
Found by exporting a real imported project and running `prisma validate` on the download. Import (`schema.prisma` → project) is a
later step and isn't covered here.

## 1. What the user sees

The project header's **Export** menu gains **Prisma schema**. It downloads `schema.prisma`,
which `prisma validate` accepts and which looks like what `prisma db pull` would write for the
same database. Like every export, it contains only what the requester can see, and a partial
view says "this export is incomplete".

## 2. Where it lives

- **The PostgreSQL engine declares a second export format**,
  `{ id: 'prisma', displayName: 'Prisma schema', fileExtension: 'prisma', supportsComments: true, supportsDrops: false }`.
  Its `EXPORTER.export` switches on `options.format`, and the new file
  `export-prisma.ts` builds the output.
- **It belongs to the engine, not to core**, because most of the work is mapping PostgreSQL
  types to Prisma (`varchar(255)` → `String @db.VarChar(255)`). A MySQL engine would ship its
  own `prisma` format.
- **Nothing changes in the api or the web app.** `renderExport`, `ExportsService` and the
  export menu already read `capabilities.exportFormats`.
- The output is one `ExportStatement` per block (datasource, generator, each enum, each
  model), with `separator: '\n'`. `renderStatements` gets a one-line fix so that a separator
  ending in a newline doesn't also get a blank line between phases.

## 3. The mapping

The reference is `prisma db pull`. Where Prisma can't express something, the output keeps the
column and adds a comment.

| Design                                    | Prisma                                                                                                                             |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| table                                     | `model`. The name is kept as is. A name Prisma can't spell is cleaned up and gets `@@map("original")`                              |
| namespaces other than `public`            | `schemas = [...]` in the datasource and `@@schema("x")` on every model and enum                                                    |
| column                                    | a field, `?` when nullable, `@map` when the name had to be cleaned up                                                              |
| `integer`, `text`, `boolean`, `jsonb`, …  | the Prisma default type, with no `@db.*`                                                                                           |
| `varchar(n)`, `uuid`, `timestamptz(p)`, … | the Prisma type plus `@db.VarChar(n)`, `@db.Uuid`, `@db.Timestamptz(p)`, …                                                         |
| `serial` / identity                       | `Int @default(autoincrement())` (`BigInt` for `bigserial`)                                                                         |
| enum                                      | `enum` block                                                                                                                       |
| domain                                    | its base type                                                                                                                      |
| array                                     | `Type[]`. Two or more dimensions become `Unsupported(...)`                                                                         |
| anything else (`interval`, ranges, …)     | `Unsupported("interval")`                                                                                                          |
| `default`                                 | number, string, boolean and enum literals as is, `now()`/`CURRENT_TIMESTAMP` → `now()`, anything else `dbgenerated("…")`           |
| primary key                               | `@id`, or `@@id([...])` for more than one column                                                                                   |
| unique constraint / unique index          | `@unique`, or `@@unique([...])` for more than one column                                                                           |
| index on plain columns                    | `@@index([...])`, plus `type: Gin` and similar when the index isn't btree                                                          |
| foreign key                               | `@relation(fields, references, onDelete, onUpdate)` on the child and a back-relation list on the parent (`Child?` when one-to-one) |
| constraint and index names                | `map: "…"` only when the name differs from Prisma's default (`orders_pkey`, `orders_email_key`, …)                                 |
| docs                                      | `///` comments on the model and the field                                                                                          |
| table with no `@id` or `@unique`          | `@@ignore` with Prisma's usual comment, so the file still validates                                                                |
| CHECK constraints, expression indexes     | left out, with a `//` comment naming them in the model                                                                             |
| views, materialized views                 | left out, with one comment line (Prisma's `view` is still a preview feature)                                                       |

- **Relation names.** The forward field is named after the parent model and the back-relation
  after the child. When two models have more than one relation between them, or a model refers
  to itself, both sides get `@relation("<foreign key name>")`, and a field name that's already
  taken gets the foreign key's columns appended.
- **Referential actions** are written only when they differ from Prisma's defaults
  (`onDelete`: `SetNull` when optional, `Restrict` when required; `onUpdate`: `Cascade`).
  PostgreSQL's default is `NO ACTION`, so most foreign keys write both.
- **Determinism and redaction** follow the DDL exporter: sorted by explicit keys, hidden
  objects skipped, a single `// Some objects are not included because of your access level.`
  header with no count, and `incomplete` set.

## 4. Tests

- `export-prisma.spec.ts` in the engine: one fixture model that covers every row of §3, with
  the output checked against a file snapshot, plus redaction and determinism (map order reversed
  gives the same bytes).
- One check that runs `prisma validate` on that output (the api already has `prisma`).

## 5. Open questions

| #   | Question                                                                     | Default                                                                                                 |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Q1  | Rename tables to PascalCase models (`order_items` → `OrderItems` + `@@map`)? | **No.** Keep names as `db pull` does. Renaming is a guess and makes the diff with a pulled schema noisy |
| Q2  | Emit views as `view` blocks?                                                 | **No** while Prisma's `views` is a preview feature                                                      |
| Q3  | `generator` provider                                                         | **`prisma-client-js`**, the one every Prisma version understands                                        |
| Q4  | Prisma import (the second half of row 7)                                     | **Later**, as its own design, once the export is in use                                                 |
