# Phase 8: ORM exporters (Drizzle, TypeORM, Django) and the shared ORM layer

Status: **approved 2026-10-04** with every default in the open-questions table. Roadmap row 8.

Decided with the owner before writing (2026-10-04):

- **Every engine gets every ORM**: PostgreSQL, MySQL/MariaDB and SQLite (row 13), each with
  Prisma, Drizzle, TypeORM and Django.
- **Option A, a shared ORM layer.** What doesn't depend on the database (names, relations,
  redaction, ordering, one writer per ORM) is written once. An engine supplies only its type
  table.

## 1. What the user sees

The **Export** menu gains **Drizzle schema**, **TypeORM entities** and **Django models**, next
to **Prisma schema**, which MySQL and SQLite projects now get too. Each downloads one file:

| Format    | File            | Looks like what this writes for the same database   |
| --------- | --------------- | --------------------------------------------------- |
| `prisma`  | `schema.prisma` | `prisma db pull` (unchanged from Phase 7)           |
| `drizzle` | `schema.ts`     | `drizzle-kit pull`, with relations in the same file |
| `typeorm` | `entities.ts`   | `typeorm-model-generator`, in one file              |
| `django`  | `models.py`     | `manage.py inspectdb`                               |

Like every export, a file contains only what the requester can see, and a partial view says
"this export is incomplete". Area scope (Q29) works the same as for DDL. The CLI's
`schemaloom pull --format drizzle` works with no CLI change, because formats come from the
engine.

## 2. Where it lives

### 2.1 `packages/orm` (new, `@schemaloom/orm`)

Pure TypeScript, no parsers, no I/O, so it is safe anywhere. It depends on `engine-sdk` and
`schema-model` only.

```ts
export type OrmId = 'prisma' | 'drizzle' | 'typeorm' | 'django';

/** One engine type, spelled for each ORM. `null` = the ORM can't express it. */
export interface OrmTypeEntry {
  readonly prisma: { scalar: string; native?: string } | null;
  readonly drizzle: { builder: string; options?: string } | null;
  readonly typeorm: { type: string } | null;
  readonly django: { field: string; options?: string; import?: string } | null;
}

/** What an engine hands the layer. */
export interface OrmDialect {
  readonly prismaProvider: 'postgresql' | 'mysql' | 'sqlite';
  readonly drizzleCore: 'pg-core' | 'mysql-core' | 'sqlite-core';
  readonly typeormType: 'postgres' | 'mysql' | 'mariadb' | 'sqlite';
  /** canonical engine type id → spellings; arguments (`varchar(255)`) are filled from TypeRef */
  readonly types: Readonly<Record<string, OrmTypeEntry>>;
  /** engine knowledge the writers need and the IR doesn't carry */
  defaultExpression(
    field: Field,
  ): { kind: 'now' | 'autoincrement' | 'literal' | 'raw'; text: string } | null;
  readonly defaultActions: { onDelete: string; onUpdate: string };
}

export function buildOrmExport(orm: OrmId, input: ExportInput, dialect: OrmDialect): ExportResult;
```

- **One plan, four writers.** `planModels(model)` works out, once, what every ORM needs:
  model and field names (cleaned up, with the original kept for `@@map`, `name:`,
  `db_table`), primary keys, unique sets, relations and back-relation names (the Phase 7
  rules: named after the other model, with the foreign key name when two models share more
  than one relation or a model refers to itself), and what has to be left out with a comment.
  Each writer (`prisma.ts`, `drizzle.ts`, `typeorm.ts`, `django.ts`) only prints the plan.
- **Prisma moves here** from `packages/engines/postgresql/src/export-prisma.ts`. Its file
  snapshot from Phase 7 stays, and the move is done when that snapshot is byte-identical.
- The redaction notice, `incomplete`, and determinism (explicit sort keys, byte comparison) are
  the layer's job, written once.

### 2.2 In each engine

- An `orm-types.ts` with the engine's `OrmDialect`. That is the only ORM code in an engine.
- `capabilities.exportFormats` gains the four formats.
- `EXPORTER.export` switches: `ddl` → its own exporter; any `OrmId` →
  `buildOrmExport(format, input, DIALECT)`.

### 2.3 Outside the packages

Nothing in the api or web. `renderExport`, `ExportsService` and the Export menu already read
`capabilities.exportFormats`, and `renderStatements` already handles a `'\n'` separator.

## 3. The mappings

Each table lists only what differs between ORMs. The rows Phase 7 §3 settled for Prisma still
hold, and the other writers follow the same choices where they can.

### 3.1 Drizzle (`schema.ts`)

| Design                       | Drizzle                                                                                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| table                        | `export const orderItems = pgTable('order_items', { … }, (t) => [ … ])` (`mysqlTable`, `sqliteTable`)                                                              |
| namespace other than default | `export const billing = pgSchema('billing')`, then `billing.table(…)` (PostgreSQL only)                                                                            |
| column                       | `customerId: integer('customer_id').notNull()`. Keys are camelCase, the database name is the first argument                                                        |
| types                        | from the engine's table: `varchar('email', { length: 255 })`, `numeric('total', { precision: 10, scale: 2 })`                                                      |
| serial / identity            | `serial()`, `integer().generatedAlwaysAsIdentity()`; `int().autoincrement()` on MySQL; `integer({ mode: 'number' }).primaryKey({ autoIncrement: true })` on SQLite |
| enum                         | `pgEnum('status', [...])` on PostgreSQL; `mysqlEnum(...)` inline on MySQL; `text({ enum: [...] })` on SQLite                                                       |
| default                      | `.default(…)` for literals, `.defaultNow()` for now, ``.default(sql`…`)`` for anything else                                                                        |
| primary key, unique, index   | `.primaryKey()` / `.unique()` on one column; `primaryKey({ columns })`, `unique().on()`, `index().on()` in the callback for more                                   |
| foreign key                  | `.references(() => customers.id, { onDelete })` on one column; `foreignKey({ columns, foreignColumns })` for more                                                  |
| relations                    | a `relations(orders, ({ one, many }) => …)` block per table, at the end of the file                                                                                |
| CHECK                        | ``check('name', sql`…`)`` in the callback                                                                                                                          |
| view                         | ``pgView('name').as(sql`…`)`` (`mysqlView`, `sqliteView`), with the body as written                                                                                |
| expression index             | left out, with a `//` comment naming it                                                                                                                            |
| docs                         | `/** … */` above the table and the column                                                                                                                          |

### 3.2 TypeORM (`entities.ts`)

| Design            | TypeORM                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| table             | `@Entity({ name: 'order_items', schema: 'billing' }) export class OrderItems { … }`. Class names are PascalCase                                          |
| column            | `@Column({ name: 'customer_id', type: 'integer', nullable: true }) customerId!: number \| null`                                                          |
| serial / identity | `@PrimaryGeneratedColumn({ type: 'integer' })` (`'identity'` strategy for identity columns)                                                              |
| other primary key | `@PrimaryColumn`, one per column for a composite key                                                                                                     |
| enum              | `type: 'enum', enum: ['a', 'b']`, plus `enumName` on PostgreSQL. SQLite: `type: 'simple-enum'`                                                           |
| unique, index     | `@Unique('name', [...])`, `@Index('name', [...], { unique })` on the class                                                                               |
| foreign key       | `@ManyToOne(() => Customers, (c) => c.orders, { onDelete })` + `@JoinColumn(…)`, and `@OneToMany` on the parent; `@OneToOne` when the columns are unique |
| CHECK             | `@Check('name', '…')`                                                                                                                                    |
| view              | `@ViewEntity({ name, expression: '…' })` with a `@ViewColumn()` per column                                                                               |
| docs              | `comment: '…'` on the column, `comment` on `@Entity`                                                                                                     |

The file imports from `typeorm` only. Classes are ordered so a parent comes before its
children; cycles work because TypeORM relations take a function (`() => Parent`).

### 3.3 Django (`models.py`)

| Design                       | Django                                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| table                        | `class OrderItems(models.Model):` with `class Meta: db_table = 'order_items'`, `managed = False` (Q3)                                                                 |
| namespace other than default | `db_table = '"billing"."order_items"'`, the form `inspectdb` users write by hand (PostgreSQL only)                                                                    |
| column                       | `customer_id = models.IntegerField(blank=True, null=True)`; `db_column=` when the name had to be cleaned up                                                           |
| types                        | from the engine's table: `CharField(max_length=255)`, `DecimalField(max_digits=10, decimal_places=2)`, `JSONField()`, `ArrayField(...)` (PostgreSQL, with its import) |
| serial / identity PK         | `AutoField(primary_key=True)` / `BigAutoField(primary_key=True)`                                                                                                      |
| composite primary key        | `pk = models.CompositePrimaryKey('a', 'b')` (Django 5.2)                                                                                                              |
| table with no primary key    | the first single-column unique gets `primary_key=True`; with none, a comment says Django needs one                                                                    |
| enum                         | a `models.TextChoices` class, and `CharField(choices=…)`                                                                                                              |
| foreign key                  | `models.ForeignKey('Customers', models.CASCADE, db_column='customer_id', related_name=…)`; `OneToOneField` when unique; actions map 1:1, `NO ACTION` → `DO_NOTHING`   |
| composite foreign key        | the plain columns stay, with a comment (Django has no composite foreign key)                                                                                          |
| unique, index                | `Meta.constraints = [models.UniqueConstraint(...)]`, `Meta.indexes = [models.Index(...)]`                                                                             |
| CHECK                        | a comment: a SQL `CHECK` body can't be turned into a `Q` object reliably                                                                                              |
| view                         | an unmanaged model with a comment that it's a view                                                                                                                    |
| docs                         | a docstring on the class, `db_comment=` on the field                                                                                                                  |

Models are ordered parent first and refer to each other by string name, so cycles work.

## 4. Tests

- **Per writer, in `packages/orm`:** one fixture plan covering every row of §3 for each
  dialect, checked against file snapshots (4 ORMs × 3 dialects), plus redaction and
  determinism (map order reversed gives the same bytes). The Phase 7 Prisma snapshot moves
  here unchanged.
- **The output compiles,** each by its own tool, in `packages/orm` tests:
  - Prisma: `prisma validate` (already done for PostgreSQL in Phase 7; now all three providers).
  - Drizzle and TypeORM: `tsc --noEmit` over the output with `drizzle-orm`, `typeorm` and
    `reflect-metadata` as dev dependencies of `packages/orm` only.
  - Django: `python -m django check` against a throwaway settings module. Skipped with a
    warning when Python or Django isn't installed. CI installs Django (`docs/ci.md`).
- **Per engine:** conformance gains `export/orm-formats-build`: every ORM format the engine
  declares exports its conformance fixture without throwing and with no `error` diagnostic.

## 5. Delivery

1. `packages/orm` with the plan and the Prisma writer; the PostgreSQL engine uses it; the
   Phase 7 snapshot is byte-identical. MySQL gets Prisma.
2. The Drizzle writer, for PostgreSQL and MySQL.
3. The TypeORM writer.
4. The Django writer.
5. SQLite gets all four when row 13 lands (its `orm-types.ts` is part of that engine).

## 6. Open questions

| #   | Question                                        | Default                                                                                                                      |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Drizzle relations: same file or `relations.ts`? | **Same file**, at the end. Every export is one file today, and a zip for one format isn't worth it                           |
| Q2  | TypeORM and Django naming                       | **Their generators' conventions**: PascalCase classes, camelCase TypeORM properties, Django fields keep the column name      |
| Q3  | Django `managed`                                | **`managed = False`**, as `inspectdb` writes. Django then never creates or drops these tables. A comment says how to flip it |
| Q4  | Minimum versions the output targets             | **Drizzle ORM 0.36+** (array-style table callback), **TypeORM 0.3**, **Django 5.2** (composite primary keys)                 |
| Q5  | Python in CI for the Django check               | **Yes**, one `pip install django` step. Locally the check skips when Python is missing                                       |
| Q6  | New dependencies                                | **Dev only, in `packages/orm`**: `drizzle-orm`, `typeorm`, `reflect-metadata`. Nothing at runtime                            |
