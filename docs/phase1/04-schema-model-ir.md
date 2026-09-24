# 04 — `packages/schema-model`: the engine-neutral IR and diff engine

Status: design pass (markdown only, no source files). Phase 1.
Depends on: `zod` and nothing else (C10).
Consumed by: `engine-sdk`, all engines, `contracts`, `apps/api`, `apps/web`.

Revision 2. The substantive changes are the redaction reconciliation with doc 05 (§10),
the deletion of the rename heuristic (§7.3), the explicit row → IR mapping (§8.1), the
explicit permission-requirement table (§8.5), and the realtime visibility-transition rule
(§8.7). Each is called out where it lands, with what revision 1 said and why it was wrong.

---

## 0. What this package is and is not

`schema-model` is the vocabulary the rest of SchemaLoom speaks. It owns:

1. **The IR** — the in-memory / transport / snapshot shape of a project's schema.
2. **The operation type** — the only way anything mutates schema objects.
3. **The diff engine** — matching + structural diff, engine-agnostic.
4. **A traversal index** — lookups, join paths, topological order.
5. **Structural validation** — integrity rules that hold for every engine.
6. **The redaction shape contract** — so `VisibilityFilter` output is still a valid IR,
   plus the `RedactedModel` brand, the `RawSchemaModel` box and `redact` itself, which
   doc 05 §8.6 requires to live in this package (C10).

It is **not** the source of truth for the live schema. Per C3, the live schema lives in
relational tables; the IR is assembled from them. It contains no I/O, no Prisma, no
React, no engine knowledge, and no `Date` objects (JSON-safe values only, so a snapshot
blob and a websocket frame are the same bytes).

Deliberate non-goals: no plugin system inside this package, no event emitter, no class
hierarchy. Plain data plus free functions.

### 0.1 Files

```
packages/schema-model/src/
  ids.ts          Id
  model.ts        IrObjectMap, IrObjectType, IR_OBJECT_TYPES, IrCollections, SchemaModel
  schemas.ts      every zod schema (§5) — the only place an IR type is defined
  types.ts        z.infer re-exports (§5)
  rows.ts         the *Row structural types assembly consumes (§8.1)
  assemble.ts     assembleModel (§8.1)
  ops.ts          SchemaOperation, batch, result, requirementsOf, applyOps, mergeResult
  index.ts        ModelIndex, createIndex, all traversal helpers (§9)
  logical-key.ts  logicalKey, byLogicalKey (§6)
  diff.ts         diffModels, deepDiff, selectors, opsFromDiff (§7, §8.8)
  validate.ts     validateModel (§11.1)
  redact.ts       RedactedModel, RawSchemaModel, VisibilityContext, redact, redactPatch,
                  BLANK, the shape contract (§10). Doc 05 §8.6 owns the *rules*; this
                  package owns the shape, the brand and the private payload.
  upgrade.ts      upgradeModel (§8.9)
```

---

## 1. Container shape: normalized maps, keyed by id

### 1.1 Decision

The root is **normalized maps keyed by id**, one map per object type, with parent links
expressed as id references and ordering expressed as an explicit `ordinal` (C11). No
nesting anywhere in the persisted or transported shape.

### 1.2 Why — the consumers, in order of pain

| Consumer | With normalized maps | With nested trees |
|---|---|---|
| **Diff** | pairwise match is a map lookup by id, O(n) total | recursive walk plus manual pairing at every level |
| **Canvas** | React Flow wants a flat `nodes[]`/`edges[]` anyway; editing one entity replaces one map entry, so `React.memo` holds for the other 299 cards | editing a leaf field rewrites the whole entity subtree, busting memoization up the chain |
| **Assembly (C3)** | `SELECT * FROM fields WHERE project_id = ?` then a per-type row mapping (§8.1) | every load rebuilds a tree, every write hunts for the right subtree |
| **AI serializer / exporter** | needs ordered walks, gets them from the index (`fieldsOf`, `topologicalEntityOrder`) | gets the order the tree happens to have, which is not the order export needs |
| **Realtime patching** | `objects.entity[id] = next` | path-walk to the node, rebuild every ancestor |

The cost of normalizing is that "children of X" needs an index — but C11 already forces
explicit ordinals, so the tree was never free. The index is one O(n) pass (§9).

### 1.3 Collections are keyed by the **singular** object-type name

`model.objects.entity[id]`, not `model.objects.entities[id]`. Not a typo: it lets every
generic routine (diff, validation, redaction, index build) be written once over
`IrObjectType` with full type safety and no plural-mapping table. `index` has no regular
plural, which would otherwise force a hand-maintained `PLURAL` const and a cast in every
generic function.

```ts
// packages/schema-model/src/ids.ts
/**
 * All ids are cuid strings (C1) and are the same values as the database row ids, so an
 * IR loaded from the DB round-trips without an id map. This holds in a redacted model
 * too: a stub or masked object carries the REAL cuid of the row it stands for (§10, doc
 * 05 §7.10), so there is no second id space and no prefix for a write route to reject.
 *
 * There is exactly ONE id type. Revision 1's ten per-object aliases (`EntityId`,
 * `FieldId`, …) were all `= string`, so TypeScript happily accepted a field id where an
 * entity id was wanted; they prevented nothing and would rot the first time a signature
 * changed without its alias. Parameter names carry the same documentation for free.
 */
export type Id = string;
```

```ts
// packages/schema-model/src/model.ts
export interface IrObjectMap {
  namespace: Namespace;
  entity: Entity;
  field: Field;
  link: Link;
  index: Index;
  constraint: Constraint;
  customType: CustomType;
  area: Area;
}

export type IrObjectType = keyof IrObjectMap;
export type IrObject = IrObjectMap[IrObjectType];

/** Stable iteration, diff, apply and export ordering rank. Do not reorder: this is the
 *  dependency order (a field needs its entity, a link needs both entities). Used by
 *  `sortPath` (§7.5) and by the server's op sort (§8.6 rule 7). */
export const IR_OBJECT_TYPES = [
  'area',
  'namespace',
  'customType',
  'entity',
  'field',
  'constraint',
  'index',
  'link',
] as const satisfies readonly IrObjectType[];

export type IrCollections = {
  [K in IrObjectType]: Record<Id, IrObjectMap[K]>;
};

export interface SchemaModel {
  /** Bumped only when the *shape* of these types changes. Snapshots live forever,
   *  so a loader must be able to say "this blob is irVersion 1, upgrade it". */
  irVersion: 1;
  projectId: Id;
  engineId: string;       // "postgresql" — resolved through the EngineRegistry
  engineVersion: string;  // "16" — the target database version, not the plugin version
  /** True when this model came out of VisibilityFilter (§10). Clients must not offer
   *  edit, export or snapshot affordances when it is set; the server re-checks anyway.
   *  `opsFromDiff` refuses to run on a diff involving one (§8.8). */
  redacted: boolean;
  objects: IrCollections;
}
```

There is no `createdAt` / `updatedAt` on IR objects: row metadata is not schema, and
carrying it would make every diff report noise. `version` **is** carried, because the
client needs it to send `expectedVersion` on the next write (C7).

---

## 2. Object types — and the core vs `engineProps` rule

### 2.1 The rule

> A property is **core** if and only if code that has no engine loaded must read it.

"Code that has no engine loaded" is a closed list, which is what makes the rule
decidable instead of a matter of taste:

- the generic canvas card, the Areas layer and edge routing;
- `VisibilityFilter` and `PermissionResolver`;
- diff matching (identity, parentage, ordering) and the diff's severity table;
- search, docs mode, and the documentation-coverage meter;
- this package's own structural validator, traversal index and cascade rules.

Everything else — defaults, collation, identity and generated columns, storage,
`ON DELETE`, partial-index predicates, enum labels, view bodies — is `engineProps`, per C4.

**The one hard constraint on `engineProps`: it must never contain a reference to another
IR object.** Core could not cascade, validate or redact it. Everywhere PostgreSQL wanted
such a reference, the reference was pulled into a core structure instead
(`IndexColumn.fieldId` with a `role`, `TypeRef.customTypeId`, `LinkEndpoint.fieldIds`).
The rule is enforced by review of each engine's `propsSchemas`, not by a runtime scan —
see §11.1.

Core properties are **not** the same set as the relational columns. Revision 1 claimed
"the core columns of the relational tables are exactly the core properties listed below";
that was false in nine places. Some columns exist for indexing or for the API and never
reach the IR (`areas.collapsed`); some IR properties are assembled from
several columns (`Entity.position` from `position_x`/`position_y`); three columns must be
added to doc 02. §8.1 prints the full mapping, per type, including those three.

### 2.2 The base every object shares

```ts
export interface IrBase {
  id: Id;
  /** Empty string is legal: links and constraints are often unnamed, and a redacted
   *  stub blanks its name. `EMPTY_NAME` (§11.1) warns only where a name is required. */
  name: string;
  /** C7. The value the client must echo as expectedVersion on the next write. */
  version: number;
  /** Engine-owned bag, validated on write by the engine's zod schema for this object
   *  kind. Always an object: never null, never an array (C4). Permanently `{}` for
   *  Area, which no engine has an opinion about — see §2.11. */
  engineProps: Record<string, unknown>;
  /** Present only in a redacted model (§10). Absent means fully visible. The level is
   *  load-bearing: doc 05 §8.3 renders `propsRedacted` as "some properties are hidden
   *  from you" rather than as a lock badge, so the UI genuinely branches on it. */
  restricted?: RestrictionMark;
  /** Every IR object this object's engine-owned expressions textually reference — a CHECK
   *  body, a partial-index predicate, a default, a generated-column expression, an index
   *  column's expression. Produced by the engine's `extractReferences` (doc 03 §3.1) on
   *  every write and import, persisted to a real `refs` column (§8.1 delta D4), and read
   *  by doc 05's R27, which blanks `engineProps` when any referenced object is invisible.
   *  Absent or empty = no cross-object expression. SERVER-OWNED (§8.3). */
  refs?: ObjectRefs;
}

/** Doc 05's three levels. `stub` = the object exists and nothing else is disclosed;
 *  `masked` = the slot is disclosed and its contents are not; `propsRedacted` = the object
 *  is fully visible but its engine-owned expressions named something the subject may not
 *  see, so `engineProps` was blanked. */
export interface RestrictionMark {
  level: 'stub' | 'masked' | 'propsRedacted';
}

export interface ObjectRefs {
  entityIds: Id[];
  fieldIds: Id[];
}
```

`doc` is **not** in the base. Doc 02's `TargetType` is `project | area | entity | field`,
so only three IR object types can carry documentation, and a permanently-`null` property
on the other five would be a lie repeated in every snapshot. `Area`, `Entity` and `Field`
declare `doc` themselves; generic code narrows with a plain `'doc' in obj`.

`position` and `area` are **not** in the base either, contra a literal reading of spec
3.1. Only canvas-placed objects have geometry (`Entity`); a field's "position" is its
`ordinal`, and a namespace has none.

### 2.3 Documentation reference

```ts
export interface DocRef {
  id: Id;
  /** A BOUNDED excerpt of the flattened TipTap text — at most `DOC_EXCERPT_CHARS`,
   *  cut on a word boundary, suffixed with "…" when truncated. Feeds the search
   *  snippet, the canvas hover card and the docs-mode list. The full text, the rich
   *  JSON and the structured facts are fetched by `id` from the docs endpoint. */
  excerpt: string;
}

export const DOC_EXCERPT_CHARS = 200;
```

`doc === null` is the canvas's "undocumented" state and the coverage meter's denominator
input, so both cost nothing. A doc row whose text is empty still yields a `DocRef` — the
object *is* documented.

Two things are deliberately **not** here:

- **`FieldDocFacts`** (business meaning, allowed values, examples, unit, owner), which
  revision 1 carried. Its only consumers are the docs panel, the docs-mode page and the
  AI context serializer — all of which run server-side or already fetch the doc row.
  Shipping `allowedValues` and `examples` for 3,000 fields is megabytes of prose in every
  project open, every broadcast and every snapshot row, for data the canvas never renders.
  `docs.structured` (doc 02) is its home.
- **The PII / restricted / deprecated flags.** They are core columns on `Field` (§2.6),
  because core filters, badges and redacts on them.

`doc` is **server-owned in every write path** (§8.3): the docs module derives the excerpt
from TipTap JSON on write, so a client able to patch it could forge search results and AI
context.

### 2.4 Namespace

```ts
export interface Namespace extends IrBase {
  /** Exactly one namespace per project has isDefault === true. It is where entities
   *  with no explicit namespace land, where stub entities land in a redacted model
   *  (§10.2), and what the "new table" dialog preselects. Engines with
   *  capabilities.supportsNamespaces === false get exactly this one, named "", so
   *  every entity has a parent and logical keys have one shape. */
  isDefault: boolean;
}
```

Core: `id`, `name`, `isDefault`, `version`. No `doc` (no `TargetType` entry), no `kind` —
a namespace is a namespace in every paradigm; only its *label* differs, and labels come
from the engine's terminology map, not from data. `engineProps`: owner, default
privileges, MongoDB collation defaults.

`entities.namespace_id` and `custom_types.namespace_id` are nullable in doc 02. Assembly
resolves `null` to the default namespace's id, so **`Entity.namespaceId` and
`CustomType.namespaceId` are non-null in the IR**. The IR is always explicit; the store
may be sparse. (This is one of the two doc 02 divergences resolved in doc 02's favour —
§8.1.)

### 2.5 Entity

```ts
export interface Entity extends IrBase {
  namespaceId: Id;
  kind: string;                  // engine-defined, §3
  /** Explicit membership, not geometric containment — Areas are permission
   *  resources (C5), so "which Area is this in" must never depend on pixels.
   *  Changing it is a `governance` severity change (§7.4), never cosmetic. */
  areaId: Id | null;
  position: Point;
  /** User-resized card box. Both optional; absent means content-derived. */
  width?: number;
  height?: number;
  /** Per-entity colour override (Radix palette token). Null = inherit the Area's. */
  color: string | null;
  doc: DocRef | null;
}

export interface Point { x: number; y: number }
```

PostgreSQL `engineProps`: `{ unlogged?, tablespace?, partitionBy?, inherits?,
rowLevelSecurity?, viewDefinition?, withCheckOption?, materializedWithData? }`.

Two judgement calls worth defending:

- **`kind` is core** although only the engine knows its values. Core must group, count,
  filter ("show only views") and pick a renderer by kind, and the diff must treat a kind
  change as structural. Core stores it; core never branches on its value.
- **`viewDefinition` is `engineProps`** even though it is arguably the most important
  property of a view. It is engine-specific SQL, core has no use for it, and the AI
  serializer and exporter are engine code that reads `engineProps` freely.

### 2.6 Field

```ts
export interface Field extends IrBase {
  entityId: Id;
  /** null = top level. Nesting is flat-with-a-parent-pointer, mirroring the
   *  `fields.parent_field_id` column exactly (spec §9). */
  parentFieldId: Id | null;
  /** Unique and DENSE among siblings (same entityId + same parentFieldId): 0…n-1.
   *  C11. Assigned by the SERVER on create (append) — see §8.6 rule 6. */
  ordinal: number;
  type: TypeRef;
  isNullable: boolean;
  /** Core columns because core filters, badges and (for isRestricted) redacts on
   *  them — the C4 exception. All three are engine-neutral: every paradigm has
   *  optional values, personal data, and deprecation. */
  isRestricted: boolean;
  isPii: boolean;
  isDeprecated: boolean;
  doc: DocRef | null;
}
```

Not core, therefore `engineProps`: `default`, `identity` (`always` | `byDefault` plus
sequence options), `generatedExpression`, `collation`, `storage`, `compression`, and
whatever PostgreSQL grows next. Notably **`default` is `engineProps`** — core never
renders or reasons about a default expression and its syntax is pure engine.

PK / FK / UNIQUE badges are **not** field flags. They are derived from `Constraint` and
`Link` objects through the index (`isPrimaryKey`, `isForeignKey`, `isUniqueField`), so
the truth lives in exactly one place and no denormalized flag can go stale.

#### TypeRef

```ts
export interface TypeRef {
  /** The type identifier as the engine spells it: "varchar", "numeric", "uuid", or the
   *  name of a CustomType. Empty string only in a redacted model (§10.2). */
  name: string;
  /** Type parameters in declaration order: varchar(255) -> [255],
   *  numeric(10,2) -> [10, 2]. CORE, and a real column (`fields.type_args`) — doc 02
   *  delta D1 in §8.1. */
  args?: readonly (string | number)[];
  /** Set when `name` resolves to a CustomType in this model (enum / domain /
   *  composite). Core needs the edge for dangling-reference validation, delete
   *  warnings, and export topological order. */
  customTypeId?: Id | null;
  /** 0 or absent = scalar, 1 = array, 2 = array of arrays. One optional number, so
   *  array-ness never has to be smuggled into `name` (which would make diffs lie) or
   *  into engineProps (which core cannot read). */
  dimensions?: number;
}
```

The type is core because the generic card, docs mode, search ("find every `uuid` column")
and the diff all need it, and because the migration generator's most important question —
"did this type change?" — must be answerable structurally rather than by string-comparing
a rendered label.

**There is no `display` property.** Revision 1 carried an engine-rendered
`display: string`, derived at assembly time and required on the object. It is deleted,
because it was the one property the client had to mint on every create and update while
the server also computed it: two renderers, guaranteed to drift on the first edge case
(`varchar(255)` versus `character varying(255)`), with the stored value depending on who
wrote the row last — after which search and docs mode return different results for
identical types. Rendering a type label is engine work, and spec 3.3 already puts "type
badges" in the engine UI plugin; the backend exporter and AI serializer render their own.
Deleting it also removes the only engine-supplied input to assembly, so `assembleModel` is
now entirely engine-free.

### 2.7 Link

A foreign key is a **Link**, not a `Constraint`. One user-visible concept, one object:
the canvas draws it, the exporter emits `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` from
it, the AI join-path search walks it. Modelling it twice creates a sync problem with no
upside. `Constraint` therefore covers PK / UNIQUE / CHECK / EXCLUDE only.

```ts
export interface Link extends IrBase {
  kind: string;                   // engine-defined, §3
  /** The referencing / child / source side. */
  from: LinkEndpoint;
  /** The referenced / parent / target side. */
  to: LinkEndpoint;
  cardinality: Cardinality;
}

export interface LinkEndpoint {
  entityId: Id;
  /** Ordered. Composite links pair `from.fieldIds[i]` with `to.fieldIds[i]`; array
   *  index IS the pairing, so both sides always have equal length — structurally
   *  guaranteed by the store, where ONE `link_endpoints` row carries both ids (§8.1).
   *  May be empty on BOTH sides for an entity-level link (a graph edge with no key
   *  columns, a link the user drew before choosing columns, or a redacted link). */
  fieldIds: Id[];
}

export type Cardinality = '1:1' | '1:N' | 'N:1' | 'N:M';
```

- **Self-reference**: `from.entityId === to.entityId` is legal; the canvas renders a loop
  edge and `Link.name` labels it.
- **Composite**: equal-length `fieldIds` arrays, paired by index.
- **N:M before a junction table exists** is representable, which is what lets the canvas
  offer "create a junction table" (spec 6.1) instead of blocking the gesture.
- `onDelete`, `onUpdate`, `deferrable`, `matchFull` are `engineProps`: the action names
  are PostgreSQL's, and MongoDB has none.

**`LinkEndpoint.role` is deleted** (revision 1 had it). It had no column in doc 02, so it
could not be persisted at all; and it was redundant — two links between the same pair are
already distinguished by their `fieldIds`, and the edge label the canvas wants is
`Link.name`, which exists on every object and does have a column.

### 2.8 Index

```ts
export interface Index extends IrBase {
  entityId: Id;
  kind: string;                   // engine access method: "btree" | "gin" | … §3
  isUnique: boolean;              // core: drives the field UNIQUE badge
  columns: IndexColumn[];         // ordered by `ordinal`
}

export interface IndexColumn {
  ordinal: number;                          // C11, dense 0…n-1
  /** Exactly one of fieldId / expression is set (INDEX_COLUMN_SOURCE, §11.1). */
  fieldId: Id | null;
  expression: string | null;                // expression-index body, engine syntax
  /** 'key' participates in the index; 'include' is a payload column (PostgreSQL
   *  INCLUDE). Core carries this distinction because the reference to a field must
   *  live in a core structure (§2.1) so that deleting the field cascades out of the
   *  INCLUDE list. Needs an `is_include` column on `index_columns` — doc 02 delta D2. */
  role: 'key' | 'include';
  direction?: 'asc' | 'desc';
  /** Per-column engine vocabulary: operator class, collation, NULLS FIRST/LAST. Backed by
   *  `index_columns.engine_props` (doc 02) and validated by the engine's
   *  `propsSchemas.indexColumn` (doc 03 §6). An `IndexColumn` is not an IR *object* — it
   *  has no id and no version — but it is the one nested structure that carries a props
   *  bag, which is why `EnginePropsKind` has an `'indexColumn'` member. */
  engineProps: Record<string, unknown>;
}
```

`engineProps` (on the index): `where` (partial predicate), `opclass`, `nullsOrder`,
`fillfactor`, `concurrently`, `tablespace`.

### 2.9 Constraint

```ts
export interface Constraint extends IrBase {
  entityId: Id;
  kind: string;                   // "primaryKey" | "unique" | "check" | "exclusion" …
  /** Ordered participating fields. Empty for a table-level CHECK or EXCLUDE. */
  fieldIds: Id[];
}
```

`engineProps`: `expression` (the CHECK / EXCLUDE body), `deferrable`, `initiallyDeferred`,
`noInherit`, `usingIndex`, exclusion operators. The `fieldIds` are core because the canvas
PK badge, the diff, the cascade rules and link validity depend on them; the expression is
not, because only the engine can parse it. Doc 02 stores the expression in a real
`constraints.expression` column for indexing and search; assembly copies that column into
`engineProps.expression`. One mapping line, no core property (§8.1).

### 2.10 CustomType

```ts
export interface CustomType extends IrBase {
  namespaceId: Id;
  kind: string;                   // "enum" | "domain" | "composite" …
}
```

Everything that varies by kind — enum labels and their order, a domain's base type and
checks, a composite's attributes — is `engineProps`. Core needs only identity, name,
namespace and kind: enough to render a chip, resolve `TypeRef.customTypeId`, order the
export, and warn when something still references a type being deleted. An enum-label
change is diffed by the generic `engineProps` deep diff and labelled destructive by the
engine (removing a label is destructive; appending one is not).

### 2.11 Area

```ts
export interface Area extends IrBase {
  /** Radix/Tailwind palette token, not a hex value: "indigo" | "amber" | … so
   *  light/dark theming stays with the design tokens. */
  color: string;
  /** C11 — order in the sidebar legend and in the Area filter list.
   *  Maps to `areas.position`. */
  ordinal: number;
  doc: DocRef | null;
}
```

`Area` **is** an `IrBase` and carries `engineProps`, permanently `{}`. Revision 1 made it
the one exception, arguing that an empty bag "for symmetry" is what C12 exists to prevent.
That was wrong in the direction that costs code: because `IrObject` is a union including
`Area`, every generic routine — the deep diff's `['engineProps', …]` walk, the
`ENGINE_PROPS_SHAPE` check, redaction's engineProps blanking, `applyOps` — needed a
`hasEngineProps(type)` narrowing first. Five guards to avoid one `{}`. The engine's
`propsSchemas` simply has no `area` entry and its validator never looks at one, so
`hasEngineProps` is deleted.

**There is no `rect`.** Revision 1 gave Area an `{x, y, width, height}` box; doc 02's
`areas` table has no geometry columns at all, so the property had no backing store.
Resolved in doc 02's favour: **the canvas derives an Area's drawn region from the bounding
box of its member entities plus a fixed padding.** Membership is explicit
(`Entity.areaId`), so the region is a pure function of data that already exists and can
never disagree with membership — which was the point of making membership explicit. An
Area with no members has no region; it appears in the sidebar legend only, ordered by
`ordinal`, until the user drops an entity into it. If the product wants free-floating
hand-drawn rectangles instead, that is four columns on `areas` and a different decision
(Open question 2).

`areas.collapsed` and `areas.description` are **not** in the IR: collapse is per-viewer
canvas state (the client store owns it, and it must not be shared, versioned and broadcast
schema data), and `description` is superseded by the `Doc` row, which `TargetType` already
supports for `area`. Both are flagged as columns doc 02 can drop (§8.1 delta D3).

---

## 3. Kind fields are plain strings in core

`Entity.kind`, `Link.kind`, `Index.kind`, `Constraint.kind` and `CustomType.kind` are
values **the engine defines**. Core must never enumerate them — the moment core writes
`kind === 'table'`, the engine boundary is gone. So in core they are typed `string`, and
the zod schema is `z.string()`.

Revision 1 declared an `OpenKind<Known> = Known | (string & {})` helper plus five aliases
(`EntityKind`, `LinkKind`, `IndexKind`, `ConstraintKind`, `CustomTypeKind`). All six are
deleted. In core `Known` is `never`, so every alias evaluated to `string & {}` — the
autocomplete trick with nothing to autocomplete — and because §5 infers every type from
its zod schema, the inferred property type was plain `string` anyway, so not one of those
aliases ever appeared in an IR type. The value was always on the engine side, and that is
where the helper now lives (`engine-sdk`).

How kinds stay usefully typed: **the engine narrows them and ships type guards.**

```ts
// packages/engines/postgresql/src/kinds.ts
import type { Entity } from '@schemaloom/schema-model';

export const PG_ENTITY_KINDS = ['table', 'view', 'materializedView'] as const;
export type PgEntityKind = (typeof PG_ENTITY_KINDS)[number];
export type PgEntity = Entity & { kind: PgEntityKind };

export const isPgEntity = (e: Entity): e is PgEntity =>
  (PG_ENTITY_KINDS as readonly string[]).includes(e.kind);

/** Exhaustiveness inside the engine still works: */
export function ddlKeyword(e: PgEntity): string {
  switch (e.kind) {
    case 'table': return 'TABLE';
    case 'view': return 'VIEW';
    case 'materializedView': return 'MATERIALIZED VIEW';
    // no default needed — TS proves the switch is exhaustive
  }
}
```

Core is honest that it does not know (`string`), engine code gets real exhaustive
switches, and the boundary is a one-line type guard rather than a registry of kinds. The
generic UI asks `engineUi.nodeRenderer(entity.kind)`, and the engine's `typeCatalog` and
`propsSchemas` are keyed by the same strings.

Kind values are **not namespaced** (`"table"`, not `"pg:table"`): a project has exactly
one engine (spec §5 hierarchy), so collisions cannot occur. Kind strings are `camelCase`
and are stable forever — they end up inside snapshot blobs.

An empty `kind` string is legal only on a redacted stub (§10.2). The engine validator
rejects an empty or unknown kind on a live model; core does not, because core has no
catalogue to check it against.

---

## 4. Field nesting and path addressing

Nesting is flat plus `parentFieldId` (§2.6). Depth is bounded by `MAX_FIELD_DEPTH = 8`,
enforced by the structural validator (`FIELD_DEPTH_EXCEEDED`) and independently gated by
the engine's `capabilities.supportsNestedFields` (PostgreSQL v1: `false`, so the effective
depth is 1 and **every `FieldPath` in v1 has exactly one element**). It is what stops a
`parentFieldId` cycle from hanging a request before the cycle check finds it.

**`MAX_FIELD_DEPTH` is declared here, in `schema-model`, and re-exported by `contracts`.**
Doc 02 §9.2 enforces the same ceiling in `createField` / `reparentField` (there is no
`fields.depth` column and no database CHECK — doc 02 deleted both), and its bounded
recursive CTE reads `WHERE s.lvl < MAX_FIELD_DEPTH + 1`. **The value is 8**, which is also
doc 03's `capabilities.maxFieldDepth` for MongoDB; doc 02's earlier "5" is superseded.

Revision 1 also specified a `FieldNode` tree, a memoized `fieldTree(ix, entityId)` builder,
and a `formatNamePath` with dot-and-quote escaping rules. All three are deleted. They are
unreachable in Phase 1 — the engines that set `supportsNestedFields: true` are tagged
Future in the spec's build order — and a recursive renderer that nothing will feed is
exactly what C12 rules out. `fieldsOf(ix, entityId, { parentFieldId })` already returns an
ordered sibling group, so the first engine that needs a tree builds one in five lines.

What stays, deliberately: `parentFieldId` itself, `FIELD_PARENT_CYCLE` and
`FIELD_PARENT_ENTITY`. The column exists in doc 02 because the spec mandates it, and
retrofitting integrity checks onto a column already carrying data is precisely what this
design pass exists to prevent.

### 4.1 Path addressing

Two addressings, and the distinction is the whole answer to "stable across renames":

```ts
/** CANONICAL. Root-to-leaf chain of ids. Stable across every rename, because ids never
 *  change (C1). This is what anything persisted or compared uses: diff entries, comment
 *  targets, doc targets, AI citations, selection chips. Single-element in v1. */
export type FieldPath = readonly Id[];

/** DISPLAY ONLY. Derived on demand; changes when anyone renames anything. Rendered by
 *  joining with "." — v1 has one segment, so there is nothing to escape. */
export type FieldNamePath = readonly string[];

export function fieldPath(ix: ModelIndex, fieldId: Id): FieldPath;
export function fieldNamePath(ix: ModelIndex, fieldId: Id): FieldNamePath;

/** Matching direction: names -> field, used when an incoming snapshot or DDL has no
 *  ids. Segments are compared through the index's `normalizeName` (§6.3). Returns
 *  undefined if any segment fails to resolve. */
export function resolveNamePath(
  ix: ModelIndex,
  entityId: Id,
  names: FieldNamePath,
): Field | undefined;
```

So `address.geo.lat` is, depending on who is asking:

- to the diff, a comment, or a permission grant: `['fld_a1', 'fld_b2', 'fld_c3']`;
- to the AI serializer, the exporter and the property-panel breadcrumb:
  `fieldNamePath(...).join('.')`.

A rename changes the second and not the first, which is exactly the required behaviour: a
comment on `address.geo.lat` survives renaming `geo` to `location`, and the next AI prompt
says `address.location.lat`.

---

## 5. zod as the single source of truth

Every IR type is written **once, as a zod schema**, and the TypeScript type is inferred
from it. Nothing in this package declares an IR type twice. The interfaces printed in §2
are the inferred results, written in interface form there only for readability.

Two shapes are named exceptions, so nobody hunts for a schema that does not exist:
`SchemaOperation` and its relatives (§8.4) are TypeScript mapped types over `IrObjectMap`
— zod cannot express "`Omit<IrObjectMap[T], ServerOwned>` for each T" without eight
hand-written duplicates, so `contracts` builds the request schema from the eight object
schemas with `.omit()` at the API boundary; and `SchemaDiff` (§7.2) is a derived,
never-parsed shape.

```ts
// packages/schema-model/src/schemas.ts
import { z } from 'zod';

export const IdSchema = z.string().min(1).max(64);

export const DocRefSchema = z.object({
  id: IdSchema,
  excerpt: z.string().max(240),   // DOC_EXCERPT_CHARS plus room for the ellipsis
});

/** engineProps: core validates the container only. The engine's propsSchemas validate
 *  the contents on write (§11.2). Arrays and null are rejected here so
 *  `{ ...engineProps }` is always safe. */
export const EnginePropsSchema = z.record(z.string(), z.unknown());

export const RestrictionMarkSchema = z.object({
  level: z.enum(['stub', 'masked', 'propsRedacted']),
});

export const ObjectRefsSchema = z.object({
  entityIds: z.array(IdSchema).max(500),
  fieldIds: z.array(IdSchema).max(2000),
});

/** Shared by all eight object schemas. `kind` is NOT here: three types have none.
 *  `doc` is NOT here: only three types can carry one (§2.2). */
export const IrBaseShape = {
  id: IdSchema,
  name: z.string().max(255),
  version: z.number().int().nonnegative(),
  engineProps: EnginePropsSchema,
  /** Only ever set by VisibilityFilter (§10). */
  restricted: RestrictionMarkSchema.optional(),
  /** Server-owned; produced by the engine's extractReferences (doc 03 §3.1). */
  refs: ObjectRefsSchema.optional(),
};

export const PointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const TypeRefSchema = z.object({
  /** Not `.min(1)`: a redacted masked field blanks it to "" (§10.2). The engine
   *  validator rejects an empty type name on a live model. */
  name: z.string().max(255),
  args: z.array(z.union([z.string(), z.number()])).optional(),
  customTypeId: IdSchema.nullish(),
  dimensions: z.number().int().min(0).max(4).optional(),
});

// --- the eight object schemas, in IR_OBJECT_TYPES order ---------------------

export const AreaSchema = z.object({
  ...IrBaseShape,
  color: z.string().min(1).max(32),
  ordinal: z.number().int().nonnegative(),
  doc: DocRefSchema.nullable(),
});

export const NamespaceSchema = z.object({
  ...IrBaseShape,
  isDefault: z.boolean(),
});

export const CustomTypeSchema = z.object({
  ...IrBaseShape,
  namespaceId: IdSchema,
  kind: z.string().max(64),
});

export const EntitySchema = z.object({
  ...IrBaseShape,
  namespaceId: IdSchema,
  kind: z.string().max(64),
  areaId: IdSchema.nullable(),
  position: PointSchema,
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  color: z.string().max(32).nullable(),
  doc: DocRefSchema.nullable(),
});

export const FieldSchema = z.object({
  ...IrBaseShape,
  entityId: IdSchema,
  parentFieldId: IdSchema.nullable(),
  ordinal: z.number().int().nonnegative(),
  type: TypeRefSchema,
  isNullable: z.boolean(),
  isRestricted: z.boolean(),
  isPii: z.boolean(),
  isDeprecated: z.boolean(),
  doc: DocRefSchema.nullable(),
});

export const ConstraintSchema = z.object({
  ...IrBaseShape,
  entityId: IdSchema,
  kind: z.string().max(64),
  fieldIds: z.array(IdSchema),
});

export const IndexColumnSchema = z
  .object({
    ordinal: z.number().int().nonnegative(),
    fieldId: IdSchema.nullable(),
    expression: z.string().max(4000).nullable(),
    role: z.enum(['key', 'include']),
    direction: z.enum(['asc', 'desc']).optional(),
    engineProps: EnginePropsSchema,
  })
  .refine((c) => (c.fieldId === null) !== (c.expression === null), {
    // Mirrors INDEX_COLUMN_SOURCE (§11.1) and doc 02's CHECK on index_columns.
    message: 'exactly one of fieldId / expression must be set',
  });

export const IndexSchema = z.object({
  ...IrBaseShape,
  entityId: IdSchema,
  kind: z.string().max(64),
  isUnique: z.boolean(),
  columns: z.array(IndexColumnSchema),
});

export const LinkEndpointSchema = z.object({
  entityId: IdSchema,
  fieldIds: z.array(IdSchema),
});

export const LinkSchema = z.object({
  ...IrBaseShape,
  kind: z.string().max(64),
  from: LinkEndpointSchema,
  to: LinkEndpointSchema,
  cardinality: z.enum(['1:1', '1:N', 'N:1', 'N:M']),
});

export const SchemaModelSchema = z.object({
  irVersion: z.literal(1),
  projectId: IdSchema,
  engineId: z.string().min(1),
  engineVersion: z.string(),
  redacted: z.boolean(),
  objects: z.object({
    area: z.record(IdSchema, AreaSchema),
    namespace: z.record(IdSchema, NamespaceSchema),
    customType: z.record(IdSchema, CustomTypeSchema),
    entity: z.record(IdSchema, EntitySchema),
    field: z.record(IdSchema, FieldSchema),
    constraint: z.record(IdSchema, ConstraintSchema),
    index: z.record(IdSchema, IndexSchema),
    link: z.record(IdSchema, LinkSchema),
  }),
});
```

```ts
// packages/schema-model/src/types.ts — the ONLY place IR types are produced
import type { z } from 'zod';
import * as S from './schemas';

export type RestrictionMark = z.infer<typeof S.RestrictionMarkSchema>;
export type ObjectRefs   = z.infer<typeof S.ObjectRefsSchema>;
export type DocRef       = z.infer<typeof S.DocRefSchema>;
export type Point        = z.infer<typeof S.PointSchema>;
export type TypeRef      = z.infer<typeof S.TypeRefSchema>;
export type Area         = z.infer<typeof S.AreaSchema>;
export type Namespace    = z.infer<typeof S.NamespaceSchema>;
export type CustomType   = z.infer<typeof S.CustomTypeSchema>;
export type Entity       = z.infer<typeof S.EntitySchema>;
export type Field        = z.infer<typeof S.FieldSchema>;
export type Constraint   = z.infer<typeof S.ConstraintSchema>;
export type IndexColumn  = z.infer<typeof S.IndexColumnSchema>;
export type Index        = z.infer<typeof S.IndexSchema>;
export type LinkEndpoint = z.infer<typeof S.LinkEndpointSchema>;
export type Link         = z.infer<typeof S.LinkSchema>;
export type SchemaModel  = z.infer<typeof S.SchemaModelSchema>;
export type Cardinality  = Link['cardinality'];
```

Conventions that keep this honest:

- **Naming**: schema is `FooSchema`, type is `Foo`. Boring, greppable, survives
  `import * as S`.
- **`kind` is `z.string()`** in core, exactly as §3 requires. The engine validates it
  against its own catalogue inside `validator`.
- **No recursion is needed in zod at all**, because field nesting is flat
  (`parentFieldId`). This is a concrete win of the normalized container: `z.lazy` plus a
  hand-written type annotation would otherwise be required, and `z.infer` cannot infer a
  recursive type on its own. With `FieldNode` deleted (§4), this package now has **no**
  recursive type at all.
- **Where parsing happens**: at trust boundaries only — API request bodies, snapshot load,
  import results, and the engine conformance tests. Assembly from our own rows and internal
  transforms do **not** re-parse; running `SchemaModelSchema.parse` on a 300-entity model
  on every read is pure waste (§12).

---

## 6. Identity: ids, logical keys, and name normalization

### 6.1 Two identities, and when each applies

`id` (a cuid, C1) is the identity. A **logical key** is a derived, human-meaningful path
used only when ids are unavailable or untrustworthy.

```ts
/** Canonical, stable, engine-neutral string identity of an object by position in the
 *  naming hierarchy. Deterministic given (model, normalizeName). */
export function logicalKey(ix: ModelIndex, type: IrObjectType, id: Id): string;
```

Every name segment is passed through the index's `normalizeName` (§6.3) and then
percent-encoded, so no name can contain a separator and no folding difference can split
what is really one object.

```
area       area:Billing
namespace  ns:public
customType type:public.order_status
entity     ent:public.orders
field      fld:public.orders.address.geo.lat
constraint con:public.orders#primaryKey(id)
constraint con:public.orders#check@orders_total_positive     <- no participating fields
index      idx:public.orders#idx_orders_customer
link       lnk:public.orders(customer_id,tenant_id)->public.customers(id,tenant_id)
link       lnk:public.orders()->public.customers()@fk_draft   <- no fields on either side
any stub   <tag>:#<id>                                        <- objects marked restricted
```

**The invariant this must satisfy, and revision 1 did not:**

> `logicalKey` is **injective per object type over any valid model, redacted or not**.

Revision 1 broke it in three ways, each of which made `validateModel` reject models the
product must accept. The fixes:

- **Constraints.** Keyed `#<kind>(<fieldNames>)` so an auto-named PK (`orders_pkey`)
  matches a hand-named one (`pk_orders`) across dumps. But `fieldIds` is empty for a
  table-level CHECK or EXCLUDE, so two business-rule CHECKs on one table both produced
  `con:public.orders#check()` — ordinary PostgreSQL, and the headline import workflow
  (spec §8 workflow 1) hit it on the first real table. **Fix:** when `fieldIds` is empty,
  the key is `#<kind>@<name>`, falling back to `#<kind>#<id>` when the constraint is also
  unnamed. Column-bearing constraints are untouched, so the churn-proof matching that
  motivated the format is preserved exactly where it mattered.
- **Links.** Keyed by endpoints, but §2.7 deliberately allows empty `fieldIds` on both
  sides, so two draft links between the same pair collided — the very case the
  N:M-before-a-junction-table story requires. **Fix:** when both sides are empty, append
  `@<name>`, falling back to `#<id>`.
- **Redacted stubs.** Every stub blanks its name to `""`, so two stubbed entities in one
  namespace both keyed to `ent:public.` — and tripped `NAME_COLLISION` besides, which made
  §10's "diffing two redacted models is legal" false whenever two entities were stubbed.
  **Fix:** an object carrying `restricted` keys as `<tag>:#<id>`. A redacted object keeps
  its **real** id (doc 05 §7.10), which is unique by construction, so the key stays
  injective; and `NAME_COLLISION` and `EMPTY_NAME` skip restricted objects (§11.1).

Indexes keep their name, because two indexes on the same columns with different kinds or
predicates are genuinely different objects and names are how humans refer to them. Areas
have no parent scope, so name alone.

### 6.2 Which matcher runs where

| Situation | Matcher | Why |
|---|---|---|
| Two snapshots of the **same project** | id first, logical key for leftovers | C1: both came from the same rows, so ids are identical unless an object was deleted and re-created |
| **Live model vs a snapshot** of the same project | id first, then logical key | same |
| **Import of external DDL / JSON** into an existing project | logical key only | incoming objects have no ids at all (or foreign ids we must not trust) |
| **Snapshot restore** after objects were hard-deleted and re-created (C8) | id first, logical key rescues the re-created ones | deletion is hard, so the new rows have new cuids for the same logical objects |
| **Cross-project compare** (staging vs prod project) | logical key only, `matchStrategy: 'logical'` | ids are unrelated between projects |

```ts
export type MatchStrategy = 'id-then-logical' | 'logical';
```

An imported model is assembled with freshly minted cuids and then matched by logical key
against the live model; the matcher's output is what tells the importer "update this
existing entity" instead of "insert a duplicate". This is also why the importer's preview
screen (spec 6.4) can show added / changed / removed before anything is written: **the
import preview is just a diff whose left side is the live model.** No second code path.

### 6.3 `normalizeName` — the one engine-supplied function core needs

All of the above compares names as strings. PostgreSQL folds unquoted identifiers to lower
case; MongoDB does not. Core cannot know which — but the matcher that decides
insert-versus-update on import **is** core. Without folding, importing
`CREATE TABLE Orders (…)` into a project that already holds `orders` produces different
logical keys, so the importer inserts a duplicate entity; `NAME_COLLISION` (exact) does
not fire, so the model saves with two tables PostgreSQL cannot both create; and the export
emits DDL that fails in the user's terminal. Revision 1 handed case folding entirely to
the engine validator (§11.2), which cannot reach the core matcher.

So core takes one pure function from the engine — now the only one, since `renderType`
went with `TypeRef.display`:

```ts
/** Engine-supplied identifier folding. Default: identity. Pure, total, idempotent:
 *  normalizeName(normalizeName(s)) === normalizeName(s). PostgreSQL's is
 *  `s => s.toLowerCase()` for unquoted identifiers; MongoDB's is the identity. */
export type NormalizeName = (name: string) => string;

export interface IndexOptions { normalizeName?: NormalizeName }
```

Used by `logicalKey`, `byLogicalKey`, `findEntityByName`, `resolveNamePath` and
`NAME_COLLISION`. It lives on the **index** (`createIndex(model, opts)`), never on
`SchemaModel`, because the model must stay JSON-safe. `DiffOptions.normalizeName` applies
the same function to both sides of a diff, and `ValidateOptions.normalizeName` to a
validation run. `indexOf(model)` — the memoized convenience accessor — uses the identity
normalizer; the API builds its per-request index with
`createIndex(model, { normalizeName: engine.normalizeName })` and passes that index
around. C10 is intact: the function is injected, never imported.

This also gives the Phase-2 `queryValidator` (spec 6.3 step 6) the lookup it needs —
`SELECT * FROM Orders` must resolve to `orders` — instead of forcing the engine to build a
second, folded index over the same data.

---

## 7. The diff engine

### 7.1 One type serves both consumers

The visual diff UI (spec 6.5) and the engine's `migrationGenerator` (spec 3.2) get the
**same `SchemaDiff`**. They want different *views* of it, not different data:

| Need | UI | migrationGenerator | Served by |
|---|---|---|---|
| Group by owning entity | yes | yes (one `ALTER TABLE` per entity) | `entriesByEntity(diff)` selector |
| Property-level before/after | yes (red/green rows) | yes (which `ALTER` clause to emit) | `PropertyChange[]` |
| Destructive flag | yes (renders red) | yes (guard / warn / require confirmation) | `PropertyChange.destructive`, engine-annotated |
| Deterministic order | yes (stable rendering, no jumping rows) | it re-orders by dependency anyway | `sortPath` |
| Ignore cosmetic noise | yes (filter toggle) | yes (a card moved 20px is not a migration) | `PropertyChange.severity` |

Two types would mean two matchers, and the matcher is the part most likely to be wrong.
One type, two selectors.

### 7.2 The types

```ts
export interface SnapshotRef {
  kind: 'live' | 'snapshot' | 'import';
  id?: Id;             // snapshot id, when kind === 'snapshot'
  label?: string;      // "v3 — before billing rework"
  capturedAt?: string; // ISO 8601 string, never a Date (JSON-safe)
}

export type ChangeType = 'added' | 'removed' | 'changed';

export type PropertySeverity =
  /** Affects the generated DDL / migration. */
  | 'structural'
  /** Changes who can see the object, or asserts something compliance-relevant about
   *  it. Emits no DDL, but a reviewer must always see it: `ignoreCosmetic` never drops
   *  it and the migration generator always skips it. */
  | 'governance'
  /** Documentation only: COMMENT ON, docs site, deprecation badge. */
  | 'documentation'
  /** Canvas geometry and presentation. */
  | 'cosmetic';

export interface PropertyChange {
  /** Path inside the object: ['name'], ['type','args',0],
   *  ['engineProps','identity','always'], ['from','fieldIds',1]. */
  path: readonly string[];
  before: unknown;
  after: unknown;
  severity: PropertySeverity;
  /** Filled by the engine's annotateDiff, never by core. `undefined` = not yet
   *  classified; the UI renders red only on `true`. */
  destructive?: boolean;
  /** Short engine-authored explanation: "narrowing varchar(255) -> varchar(64)
   *  truncates existing values". */
  note?: string;
}

interface DiffEntryBase {
  objectType: IrObjectType;
  id: Id;                       // `after` id for added/changed, `before` id for removed
  logicalKey: string;
  /** The entity this change belongs to, for grouping. Set for field, index,
   *  constraint, and for link (its `from` entity). Undefined for namespace,
   *  customType, area, and for the entity entry itself. */
  ownerEntityId?: Id;
  /** Precomputed, opaque, lexicographically sortable ordering key (§7.5). */
  sortPath: string;
}

export type DiffEntry =
  | (DiffEntryBase & { change: 'added'; after: IrObject })
  | (DiffEntryBase & { change: 'removed'; before: IrObject })
  | (DiffEntryBase & {
      change: 'changed';
      before: IrObject;
      after: IrObject;
      properties: PropertyChange[];
      /** How the two sides were paired. 'pinned' means a human confirmed the pair via
       *  DiffOptions.pinnedRenames; it is never inferred. */
      matchedBy: 'id' | 'logicalKey' | 'pinned';
    });

export interface SchemaDiff {
  irVersion: 1;
  engineId: string;
  from: SnapshotRef;
  to: SnapshotRef;
  /** True when either input model had `redacted === true`. `opsFromDiff` throws on
   *  such a diff (§8.8). */
  redacted: boolean;
  /** Sorted by `sortPath`. One flat array, discriminated by objectType. */
  entries: DiffEntry[];
  summary: {
    added: number;
    removed: number;
    changed: number;
    destructive: number;   // entries with at least one destructive PropertyChange
    byObjectType: Record<IrObjectType, { added: number; removed: number; changed: number }>;
  };
}

export interface DiffOptions {
  matchStrategy?: MatchStrategy;              // default 'id-then-logical'
  /** Pairs confirmed by a human (the diff UI's "these are the same object" action).
   *  ALWAYS applied. There is no heuristic pass and therefore no mode switch — see
   *  §7.3. */
  pinnedRenames?: { objectType: IrObjectType; removedId: Id; addedId: Id }[];
  /** Drop cosmetic-only entries entirely. The migration generator passes true.
   *  NEVER drops a `governance` change. */
  ignoreCosmetic?: boolean;
  /** Engine identifier folding (§6.3). Applied to both sides. Default: identity. */
  normalizeName?: NormalizeName;
}

export function diffModels(
  before: SchemaModel,
  after: SchemaModel,
  options?: DiffOptions,
): SchemaDiff;
```

Selectors (the whole reason one type suffices):

```ts
export function entriesByEntity(diff: SchemaDiff): Map<Id, DiffEntry[]>;
/** Narrows, which was the point of the generic — revision 1's return type ignored T. */
export function entriesOfType<T extends IrObjectType>(
  diff: SchemaDiff, t: T,
): Extract<DiffEntry, { objectType: T }>[];
export function destructiveEntries(diff: SchemaDiff): DiffEntry[];
export function isEmptyDiff(diff: SchemaDiff, opts?: { ignoreCosmetic?: boolean }): boolean;
```

### 7.3 Matching algorithm

Three passes, per object type, in order. Each pass only sees what the previous passes left
unmatched.

**Pass 1 — id.** `before.objects[t][id]` and `after.objects[t][id]` with the same key are
the same object. Skipped entirely when `matchStrategy === 'logical'`. O(n).

**Pass 2 — logical key.** Build `Map<logicalKey, Id>` for the unmatched remainder on each
side; equal keys pair up. A key colliding on one side leaves both sides unmatched and emits
a `DUPLICATE_LOGICAL_KEY` warning — a degraded match, not a corrupt model, which is why
§11.1 demotes that code from error to warning. O(n).

**Pass 3 — pinned pairs.** `DiffOptions.pinnedRenames` pairs are applied directly,
regardless of what passes 1 and 2 did. A pinned pair produces **exactly one `changed`
entry** with `matchedBy: 'pinned'` and a `PropertyChange` on `['name']` alongside every
other property that differs — which is also exactly what the migration generator needs to
emit `RENAME COLUMN` **plus** the accompanying `ALTER TYPE`.

That single representation replaces revision 1's two. It had a `renamedTo?: Id` on the
`removed` variant *and* a `matchedBy: 'rename'` on the `changed` variant, never said which
one an applied rename produced, and the `removed`+`renamedTo` form carried no
`properties[]` — so a rename that also changed the type silently lost the type change, and
the migration generator would have emitted `RENAME COLUMN` with no `ALTER TYPE`.
`renamedTo` is deleted.

**There is no rename heuristic.** `RENAME_WEIGHTS`, `RENAME_THRESHOLD`, `RenameSuggestion`,
`SchemaDiff.renameSuggestions`, `DiffOptions.detectRenames`, `DiffEntry.confidence`, the
greedy scoped assignment and the inline Levenshtein are all deleted, for three reasons that
compound:

1. **It did not work.** Entities have no `ordinal` and the type-similarity weight was
   fields-only, so an entity's maximum reachable score was `0.20 + 0.30 = 0.50` against a
   `0.6` threshold — a plain table rename, the single most common rename there is, could
   never even be *suggested*. Meanwhile a field could score `1.20` (1.40 with `sameKind`)
   on a `confidence` documented as `0..1`, so the UI would have rendered 120%. And the
   highest-weighted signal, `sameTypeDisplay: 0.45`, compared `type.display` — the one
   property §2.6 forbade reasoning about, and which no longer exists.
2. **The screen it feeds does not exist.** Revision 1's own open question admitted nobody
   has designed the confirm-rename flow; it belongs to the Phase 4 diff/history document,
   which will own the UI, the candidate generator and the tuning, with real diffs in front
   of it.
3. **The safe default is the no-op.** A false rename emits `ALTER TABLE … RENAME COLUMN`
   and silently lands production data in a column that means something else. Drop+add is
   correct, just noisier. Phase 1 needs matching for the import preview, which logical keys
   already handle.

What survives is the shape: `pinnedRenames` and `matchedBy: 'pinned'` stay, because
snapshots are permanent data and Phase 4 will need somewhere to put a confirmed pair.

Failure modes of what remains, stated plainly:

| Input | Result | Severity |
|---|---|---|
| Two fields swap names (same project) | each matches by id → two `changed` entries with a `name` property change | harmless |
| Same, across projects (logical key only) | both drop+add | noisy; emitted SQL still correct |
| Entity renamed in the same project | id match → one `changed` entry with a `name` change | correct, and this is the common case |
| Entity renamed, compared against an import or another project | drop+add until a human pins the pair | conservative and correct for migrations |
| Entity renamed **and** moved to another namespace | id match saves the same-project case; otherwise drop+add | documented limitation |
| Auto-named constraints (`orders_pkey` vs `pk_orders`) | logical key ignores column-bearing constraint names, so they match | this is why §6.1 keys them by kind+fields |
| Two table-level CHECKs on one table | distinct logical keys via the `@<name>` discriminator | fixed in revision 2 |

### 7.4 Diffing `engineProps` without understanding it

A generic deep structural diff over JSON values, emitting one `PropertyChange` per leaf
difference with a path:

```ts
export function deepDiff(
  before: unknown,
  after: unknown,
  basePath: readonly string[],
): PropertyChange[];
```

Rules, all deliberately dumb:

1. Walk objects key-by-key (union of keys, sorted, so output order is deterministic).
2. `undefined` and a missing key are the same thing; `null` is a value distinct from both.
   Normalized before comparison so `{}` versus `{ x: undefined }` produces nothing.
3. Arrays compare **by index** (`path: ['engineProps','labels','2']`), unless every element
   is an object with an `id` key, in which case they match by `id` and report
   added/removed/moved elements. Enum labels are plain strings, so an insertion in the
   middle reports as a chain of changes.
   ```
   ponytail: index-based array diff. Noisy for mid-array inserts of scalars. The engine
   can post-process its own arrays in annotateDiff, which is where that knowledge lives.
   ```
4. Every emitted change under `['engineProps', …]` gets `severity: 'structural'`. Core
   cannot tell which engine props are cosmetic, and "assume it matters" is the safe
   default.
5. Depth cap 12, cycle-safe by construction (input is JSON).

**Core-property severities** are a fixed table, and it is short enough to print:

| Path | Severity | Why |
|---|---|---|
| `name`, `type.*`, `isNullable`, `ordinal` (field, index column), `parentFieldId`, `entityId`, `namespaceId`, `kind`, `cardinality`, `from.*`, `to.*`, `columns.*`, `fieldIds.*`, `isUnique` | structural | emits DDL |
| `isRestricted`, `isPii`, `areaId` | **governance** | changes who can see the object, or asserts something a compliance reviewer must see. No DDL. |
| `doc.*`, `isDeprecated` | documentation | `COMMENT ON`, docs site, deprecation badge |
| `position`, `width`, `height`, `color`, `ordinal` (area) | cosmetic | a card moved 20px is not a migration |
| `version`, `restricted`, `refs` | **excluded from the diff entirely** | bookkeeping, redaction marks, and a derived index of what an expression already reported as a `structural` change |

`isRestricted`, `isPii` and `areaId` were all `cosmetic` in revision 1 (`isRestricted` was
structural, which contradicted the other two), and that was a real defect:
`ignoreCosmetic: true` is what the history UI's default filter and the migration generator
both pass, so a change that granted or revoked access to a table — moving an entity between
Areas is exactly that, since Areas are grantable resources (C5) — would have been invisible
in precisely the review that exists to catch it. The `governance` severity lets
`ignoreCosmetic` stay a simple boolean while never hiding a visibility change, and lets the
migration generator skip these without the engine having to learn which `structural` paths
emit no SQL.

`Area.ordinal` is legend order, hence cosmetic; `Field.ordinal` is column order, hence
structural.

### 7.5 Deterministic ordering

Every entry carries a precomputed `sortPath`, and `entries` is sorted by plain string
comparison of it. No comparator needs the model, so re-sorting in the browser is free.

```
sortPath = <typeRank>/<namespace>/<entity>/<ordinalPath>/<name>/<id>
```

- `typeRank` — the **two-digit** index in `IR_OBJECT_TYPES`: `00` area, `01` namespace,
  `02` customType, `03` entity, `04` field, `05` constraint, `06` index, `07` link.
  (Revision 1's worked example printed `40` for a field, which is at index 4 — the example
  and the stated format contradicted each other.)
- `namespace` — the name of the **owning** namespace; for a namespace entry, its own name;
  empty for `area`.
- `entity` — the name of the **owning** entity; empty for an entity entry itself; for a
  link, the `from` entity.
- `ordinalPath` — for a field, the dotted chain of 4-digit ordinals from the root field
  down to this field (`0003.0000`), so a child sorts immediately under its parent; for an
  area, its own 4-digit `ordinal`; **empty for every other type**. (Revision 1 claimed a
  nested field sorts under its parent because the path "uses the full name path", which was
  false: the ordinal segment was the child's own ordinal within its parent, so a child at
  ordinal 0 sorted to `0000/…`, ahead of its parent at `0003/…`.)
- `name` / `id` — the object's own. The trailing id makes the sort total, so two objects
  with identical names never swap places between renders.
- **Every segment is percent-encoded** (`encodeURIComponent`) before joining, so a name
  containing `/` cannot reorder the list. The comparison is a plain string compare on the
  encoded form.

One worked example per object type, for `public.orders` with a nested field
`address.geo.lat`:

```
area        00///0002/Billing/clx_area_billing
namespace   01/public///public/clx_ns_public
customType  02/public///order_status/clx_ct_status
entity      03/public///orders/clx_ent_orders
field       04/public/orders/0003/customer_id/clx_fld_cust
field       04/public/orders/0003.0000/lat/clx_fld_lat
constraint  05/public/orders//orders_pkey/clx_con_pk
index       06/public/orders//idx_orders_customer/clx_idx_cust
link        07/public/orders//fk_orders_customer/clx_lnk_cust
```

Removed entries use the *before* model's names; added and changed use *after*. Ordinals are
dense `0…n-1` (server-assigned, §8.6 rule 6), so four digits covers 10,000 siblings; if gap
ordinals are ever adopted the width must widen with them (Open question 9).

### 7.6 Nested fields and link endpoints in the diff

- **Nested fields** need nothing special: they are ordinary field entries. The dotted
  `ordinalPath` puts a child directly under its parent, and `ownerEntityId` groups them with
  the entity. Re-parenting a field is a `parentFieldId` property change, structural.
- **Link endpoints** diff as paths `['from','fieldIds','0']` etc. Because the arrays are
  positional pairs, an index-based array diff is exactly right here. Adding a second column
  to a composite FK produces `['from','fieldIds','1']` and `['to','fieldIds','1']` added —
  which is precisely what the migration generator needs to emit a drop-and-recreate of the
  constraint.
- Endpoint `entityId` changing means the link was re-pointed: structural, and the engine
  will mark it destructive (it is a drop + add in SQL).

### 7.7 Engine annotation

Core produces a fully-formed, unannotated diff. The engine adds risk semantics:

```ts
// Declared in engine-sdk (doc 03 §3 and §11.1); listed here because schema-model
// defines the shape that flows through it.
annotateDiff(diff: SchemaDiff, before: SchemaModel, after: SchemaModel): AnnotatedDiff;
```

**`AnnotatedDiff` is doc 03's type, not this package's** (doc 03 §11.1):
`SchemaDiff & { annotatedBy: EngineId; entryRisk: Record<`${type}:${id}`, { destructive, note? }> }`.
It is branded so the migration generator cannot be handed an unannotated diff, and its
`entryRisk` side map is where an `added` / `removed` entry carries destructiveness — this
package's `PropertyChange[]` exists only on `changed` entries, so a `DROP TABLE` has no
property to hang it on. `SchemaDiff.summary.destructive` therefore counts only `changed`
entries with a destructive property; the entry-level count lives on `AnnotatedDiff`. That
split is deliberate: core stays engine-free and doc 03 owns risk.

It may set `destructive` and `note` on any `PropertyChange`, and may refine severity
downward within `structural → documentation → cosmetic` — never upward, and never into or
out of `governance`, which is core's call alone. Core pre-sets exactly one thing, because
it is universally true: **a `removed` entry for a namespace, entity, field or custom type
is destructive.** Everything else — `varchar(255) → varchar(64)`, `NOT NULL` added, an enum
label dropped, a partial index predicate narrowed — is engine knowledge and stays engine
knowledge.

The API calls `annotateDiff` through the registry (`project.engineId`) before returning a
diff to the client or handing it to `migrationGenerator`, so the visual diff and the
migration script always agree about what is red.

---

## 8. Assembly, rows, and the mutation boundary

### 8.1 Read path: assembling the IR from rows (C3)

One pure function, no Prisma, no I/O, **and no engine input**, so it is trivially
unit-testable and cannot drift into a data-access layer:

```ts
// packages/schema-model/src/rows.ts
// Plain structural types OWNED BY schema-model. The API maps Prisma rows onto them (a
// field rename in most cases); schema-model never imports Prisma (C10). Revision 1
// referenced `AreaRow`, `EntityRow` and six siblings without defining any of them, so
// `AssemblyInput` did not compile.
// Timestamps are deliberately absent — row metadata is not schema (§1.3).

type Props = Record<string, unknown>;

export interface AreaRow {
  id: Id; name: string; color: string; position: number; version: number;
}
export interface NamespaceRow {
  id: Id; name: string; isDefault: boolean; engineProps: Props; refs: ObjectRefs;
  version: number;
}
export interface CustomTypeRow {
  id: Id; namespaceId: Id | null; name: string; kind: string;
  engineProps: Props; refs: ObjectRefs; version: number;
}
export interface EntityRow {
  id: Id; namespaceId: Id | null; areaId: Id | null; name: string; kind: string;
  positionX: number; positionY: number; width: number | null; height: number | null;
  color: string | null; engineProps: Props; refs: ObjectRefs; version: number;
}
export interface FieldRow {
  id: Id; entityId: Id; parentFieldId: Id | null; name: string;
  dataType: string; customTypeId: Id | null;
  typeArgs: readonly (string | number)[];   // fields.type_args        — doc 02 delta D1
  typeDimensions: number;                   // fields.type_dimensions  — doc 02 delta D1
  position: number; isNullable: boolean;
  isRestricted: boolean; isPii: boolean; isDeprecated: boolean;
  engineProps: Props; refs: ObjectRefs; version: number;   // fields.refs — delta D4
}
export interface ConstraintRow {
  id: Id; entityId: Id; name: string | null; kind: string;
  expression: string | null; engineProps: Props; refs: ObjectRefs; version: number;
}
export interface ConstraintColumnRow { constraintId: Id; ordinal: number; fieldId: Id }
export interface IndexRow {
  id: Id; entityId: Id; name: string; method: string; isUnique: boolean;
  engineProps: Props; refs: ObjectRefs; version: number;
}
export interface IndexColumnRow {
  indexId: Id; ordinal: number; fieldId: Id | null; expression: string | null;
  direction: string; isInclude: boolean;    // index_columns.is_include — doc 02 delta D2
  engineProps: Props;                       // opclass, collation, NULLS order
}
export interface LinkRow {
  id: Id; name: string | null; kind: string;
  cardinality: 'one_to_one' | 'one_to_many' | 'many_to_one' | 'many_to_many';
  sourceEntityId: Id; targetEntityId: Id; engineProps: Props; refs: ObjectRefs;
  version: number;
}
export interface LinkEndpointRow {
  linkId: Id; ordinal: number; sourceFieldId: Id; targetFieldId: Id;
}
export interface DocRow {
  id: Id; targetType: 'area' | 'entity' | 'field'; targetId: Id;
  plainText: string | null;
}
```

```ts
export interface AssemblyInput {
  projectId: Id;
  engineId: string;
  engineVersion: string;
  /** Plain rows, already scoped by projectId (C6) — one indexed query per table. */
  rows: {
    area: AreaRow[];
    namespace: NamespaceRow[];
    customType: CustomTypeRow[];
    entity: EntityRow[];
    field: FieldRow[];
    constraint: ConstraintRow[];
    constraintColumn: ConstraintColumnRow[];
    index: IndexRow[];
    indexColumn: IndexColumnRow[];
    link: LinkRow[];
    linkEndpoint: LinkEndpointRow[];
    doc: DocRow[];
  };
}

/** ALWAYS sets `redacted: false`: assembly reads raw rows, and only VisibilityFilter
 *  produces a redacted model (§10). Never throws on referential problems — it is a
 *  pure projection, and `validateModel` is what reports them. */
export function assembleModel(input: AssemblyInput): SchemaModel;
```

Twelve indexed queries on `project_id`, no joins, no N+1. A project's IR is assembled per
request; the canvas fetches it once when the project opens and then keeps it current by
applying realtime frames.

#### Row → IR mapping, per type

Revision 1 claimed "row shape maps 1:1 to IR shape, so assembly is `keyBy('id')` plus
attaching `doc` and `display`". Here is the real mapping. Anything not listed is a straight
copy of the same-named property.

**Area** — `AreaRow` → `Area`

| IR | Row | Note |
|---|---|---|
| `ordinal` | `position` | C11 legend order |
| `engineProps` | — | always `{}` (§2.11) |
| `doc` | `DocRow` where `targetType = 'area'` | |
| — | `collapsed`, `description` | **not in the IR** (§2.11) |
| — | *(no geometry columns exist)* | `Area.rect` deleted; the region is derived from members |

**Namespace** — straight copy. No `doc` (`TargetType` has no `namespace` entry).

**CustomType** — `namespaceId` is `row.namespaceId ?? defaultNamespaceId`.

**Entity** — `EntityRow` → `Entity`

| IR | Row |
|---|---|
| `position` | `{ x: positionX, y: positionY }` |
| `namespaceId` | `row.namespaceId ?? defaultNamespaceId` — non-null in the IR (§2.4) |
| `width` / `height` | `width ?? undefined` / `height ?? undefined` |
| `color` | `color` (nullable pass-through) |
| `doc` | `DocRow` where `targetType = 'entity'` |

**Field** — `FieldRow` → `Field`

| IR | Row |
|---|---|
| `ordinal` | `position` |
| `type` | `{ name: dataType, args: typeArgs.length ? typeArgs : undefined, dimensions: typeDimensions || undefined, customTypeId }` |
| `doc` | `DocRow` where `targetType = 'field'` |
| `refs` | `refs` — straight copy of the JSON column; `undefined` when both arrays are empty, so an unreferencing object adds nothing to the payload |

There is no `depth` column to map: doc 02 §9.2 deleted it, and the IR recomputes depth from
`parentFieldId` when it needs it (`fieldDepth`, §9).

**Constraint** — `ConstraintRow` + `ConstraintColumnRow[]` → `Constraint`

| IR | Row |
|---|---|
| `name` | `name ?? ''` |
| `fieldIds` | this constraint's `constraintColumn` rows ordered by `ordinal`, mapped to `fieldId` |
| `engineProps.expression` | `expression` — the column is copied into the bag (§2.9) |

**Index** — `IndexRow` + `IndexColumnRow[]` → `Index`

| IR | Row |
|---|---|
| `kind` | `method` |
| `columns[i]` | `{ ordinal, fieldId, expression, role: isInclude ? 'include' : 'key', direction, engineProps }` |

**Link** — `LinkRow` + `LinkEndpointRow[]` → `Link`

| IR | Row |
|---|---|
| `name` | `name ?? ''` |
| `from` | `{ entityId: sourceEntityId, fieldIds: endpoints.map(e => e.sourceFieldId) }` |
| `to` | `{ entityId: targetEntityId, fieldIds: endpoints.map(e => e.targetFieldId) }` |
| `cardinality` | `one_to_one`→`'1:1'`, `one_to_many`→`'1:N'`, `many_to_one`→`'N:1'`, `many_to_many`→`'N:M'` |

Endpoints are ordered by `ordinal`. Because **one** `link_endpoints` row carries *both*
field ids, `from.fieldIds.length === to.fieldIds.length` is structurally guaranteed by the
store, and a field cascade that deletes an endpoint row removes index `i` from both sides
at once — so the positional pairing can never silently shift. That is a real property of
doc 02's shape, and §8.6 rule 8 depends on it.

**DocRef** — `DocRow` → `{ id, excerpt: truncate(plainText ?? '', DOC_EXCERPT_CHARS) }`.
`doc === null` means no row exists.

#### Deltas doc 02 must adopt

| # | Change | Status | Why it cannot be `engineProps` |
|---|---|---|---|
| **D1** | `fields.type_args Json @default("[]")` and `fields.type_dimensions Int @default(0)` | **adopted by doc 02** | `TypeRef.args` / `dimensions` are core (§2.6): the diff must answer "did the type change?" structurally, and core search matches on them. With them in `engineProps`, a `varchar(255) → varchar(64)` change surfaces **twice** — once as `type.args.0` and once as `engineProps.length` — and the migration generator sees two unrelated changes. |
| **D2** | `index_columns.is_include Boolean @default(false)` | **adopted by doc 02** | `IndexColumn.role` is core. INCLUDE columns in `indexes.engineProps` would mean a **field id reference inside `engineProps`** — the one thing §2.1 forbids, because deleting that field would then not cascade out of the INCLUDE list. |
| **D3** | drop `areas.collapsed` and `areas.description` | `description` dropped; **`collapsed` still to drop** | Neither is in the IR (§2.11). `collapsed` is per-viewer canvas state and belongs in the browser, by exactly the argument doc 02 already used to move snap-to-grid there. |
| **D4** | `refs Json @default("{\"entityIds\":[],\"fieldIds\":[]}")` on every table that carries `engine_props` (`namespaces`, `entities`, `fields`, `links`, `indexes`, `constraints`, `custom_types`), validated by `objectRefsSchema` | **new — required by doc 05 R27** | `IrBase.refs` is the only thing that lets core redact an expression it is forbidden to parse. It replaces doc 03's earlier three `*_referenced_field_ids` arrays, which missed `CREATE INDEX ON employees ((salary * 12))` — an expression that names no field id at all. |

Two divergences resolved the **other** way, needing no doc 02 change:
`entities.namespace_id` and `custom_types.namespace_id` stay nullable (assembly resolves
null to the default namespace), and `constraints.expression` stays a real column (assembly
copies it into `engineProps.expression`).

### 8.2 Write path: the decision

> **Rows are the truth. A typed `SchemaOperation` batch is the only write API. The IR is
> the read model. Clients patch their in-memory IR from the batch result; the server never
> rebuilds and re-sends a whole IR after a write.**

Rejected alternatives, with the reason each loses:

- **Free-form IR patches (JSON Patch / immer patches against the IR tree).** The IR is
  derived (C3), so a patch path like `/objects/field/abc/name` has to be translated back
  into a row update anyway — it is an update op with extra parsing and no type safety.
  Worse, JSON Patch can express writes the relational model cannot honour (inventing a
  collection key, patching a derived value), so the server would need a whitelist of legal
  paths, which is the typed op list written in a worse language.
- **Plain REST, one request per object.** "Create a table with five columns and a primary
  key" is seven rows; paste-three-tables is thirty; an import is hundreds. Seven requests
  means seven transactions, seven permission checks, seven broadcasts, seven activity-log
  rows, and a half-created table if number four fails. One user gesture must be one
  transaction.
- **Full-IR PUT (send the whole model back).** Loses per-object versions (C7 degrades to
  last-write-wins over the entire project), makes every autosave a megabyte upload, and
  makes per-object permission checks impossible.

### 8.3 What the client never sets

```ts
/** Fields the client never sets: the server owns them.
 *  - version    C7, bumped by the server.
 *  - restricted produced by VisibilityFilter only (§10).
 *  - refs       produced by the engine's extractReferences (doc 03 §3.1) on every write.
 *               A client able to patch it could empty the array and un-redact the very
 *               expression doc 05 R27 uses it to hide.
 *  - doc        DERIVED. The docs module flattens TipTap JSON into the excerpt on
 *               write; a client able to patch it could forge search results and AI
 *               context. Documentation is edited through the docs endpoint (§8.10),
 *               never through a schema op. Revision 1 left `doc` patchable AND routed
 *               that patch to `docs:edit`, which meant either docs edits could not flow
 *               through the batch (dead rule) or `excerpt` was forgeable.
 */
type ServerOwned = 'version' | 'restricted' | 'refs' | 'doc';
```

`ordinal` is additionally server-owned **on create only** (§8.6 rule 6), which the op types
express directly.

### 8.4 The operation type

```ts
// packages/schema-model/src/ops.ts

/** Fields are appended by the server, so a create never carries an ordinal. Everything
 *  else keeps its ordinal in the create payload (index columns are part of the index
 *  object; areas carry legend order). */
type CreatePayload<T extends IrObjectType> =
  T extends 'field'
    ? Omit<IrObjectMap['field'], ServerOwned | 'ordinal'>
    : Omit<IrObjectMap[T], ServerOwned>;

export type CreateOp = {
  [T in IrObjectType]: { op: 'create'; type: T; object: CreatePayload<T> };
}[IrObjectType];

/** Canvas geometry is NOT patchable here. `position`, `width` and `height` go through the
 *  geometry endpoint (§8.11), which neither reads nor bumps `version` — doc 02 §10.4's C7
 *  carve-out. An update op whose patch names one of them is a 422. */
type Geometry = 'position' | 'width' | 'height';

export type UpdateOp = {
  [T in IrObjectType]: {
    op: 'update';
    type: T;
    id: Id;
    expectedVersion: number;                                   // C7
    patch: Partial<Omit<IrObjectMap[T], 'id' | ServerOwned | Geometry>>;
  };
}[IrObjectType];

export type DeleteOp = {
  [T in IrObjectType]: { op: 'delete'; type: T; id: Id; expectedVersion: number };
}[IrObjectType];

/** Reordering a field is a MOVE, never a patch of `ordinal` and never a full ordered list.
 *  Doc 05 R22 / L20: a redacted client cannot send a dense ordinal array without clobbering
 *  the positions of fields it was not shown. The server recomputes ordinals over the TRUE
 *  sibling list, so `beforeFieldId` may legitimately name a field the client sees masked,
 *  and `null` means "append after the entity's true last sibling".
 *
 *  `expectedVersion` is the OWNING ENTITY's (doc 02 §9.3): one conflict check per gesture,
 *  not N racing per-row checks. It is the same rule the ordered child tables use — a write
 *  to `link_endpoints` / `index_columns` / `constraint_columns` is expressed here as an
 *  ordinary `update` of the parent `link` / `index` / `constraint` object, carrying that
 *  parent's version (doc 02 §10.4). */
export type MoveOp = {
  op: 'move';
  type: 'field';
  id: Id;
  /** Re-parent as part of the same gesture; omit to keep the current parent. */
  parentFieldId?: Id | null;
  beforeFieldId: Id | null;
  /** The owning entity's version. */
  expectedVersion: number;
};

export type SchemaOperation = CreateOp | UpdateOp | DeleteOp | MoveOp;

export interface SchemaOperationBatch {
  /** Client-generated cuid. A CORRELATION id — it tags the activity-log row, lets the
   *  author's client recognise its own echo, and appears in logs. It is NOT an
   *  idempotency key; §8.7 states the retry rule instead. */
  batchId: Id;
  projectId: Id;
  /** Client order is preserved within an object type; the server sorts across types
   *  (§8.6 rule 7). A create may reference an id created earlier in the same batch. */
  ops: SchemaOperation[];
  /** Shown in the activity log: "Import DDL", "Paste 3 tables", "Auto-layout". */
  label?: string;
}

export interface SchemaOperationResult {
  batchId: Id;
  /** Routing: a client subscribed to two projects must be able to discard the other
   *  one's frames. */
  projectId: Id;
  /** Who wrote it. Null for system writes (a job, a cascade from a project setting).
   *  Lets the author's client tell its own echo from a peer's write, which §8.7's
   *  "one merge path" claim requires. */
  actorUserId: Id | null;
  /** Per-project monotonic sequence, assigned inside the same transaction as the
   *  write. A client whose last-seen seq is more than one behind MUST refetch the model
   *  instead of applying (§8.7). */
  seq: number;
  /** Post-images of everything created, updated, OR modified by a server-side cascade
   *  (§8.6 rule 8), ready to merge into a client's `model.objects[type][id]`. */
  changed: Partial<IrCollections>;
  /** Everything removed, including server-side cascades. NEVER filtered per recipient
   *  (§8.7): an id alone leaks nothing, and every client must converge. */
  removed: { type: IrObjectType; id: Id }[];
}

/** Doc 05 §8.1 names the realtime payload `IrPatch`. It IS this type; the alias exists so
 *  `redactPatch(patch: IrPatch, ctx): IrPatch | null` compiles against this package
 *  without either document renaming anything. Spelled `IrPatch` to match `IrBase` /
 *  `IrObject` / `IrObjectRef`. */
export type IrPatch = SchemaOperationResult;

export interface VersionConflict {
  type: IrObjectType;
  id: Id;
  expectedVersion: number;
  actualVersion: number;
  /** The current server object, so the client can rebase without a refetch. ALWAYS
   *  passed through VisibilityFilter for the requesting user before it leaves the
   *  server, and omitted entirely when the object is not visible to them. Revision 1
   *  shipped it raw, which — combined with a permission check that never looked at
   *  field-level restriction — let anyone with `schema:edit` on an entity read a hidden
   *  field's name, type, docs and engineProps out of a deliberately-stale 409 body.
   *  §8.6 rule 1 now makes that case unreachable as well. */
  current: IrObject;
}
```

Transport: `POST /projects/:projectId/schema/ops` returns `SchemaOperationResult`, or `409`
with `{ code: 'VERSION_CONFLICT', conflicts: VersionConflict[] }`. Exactly one write
endpoint for the whole schema domain.

### 8.5 Permission requirements, derived from the op

Revision 1 derived the required atom from the shape of the patch: "`docs:edit` when every
key in `patch` lies within `doc`, otherwise `schema:edit`", with a single
`resourceOf(op)` returning one resource. That was both unsafe and incomplete —
`isRestricted` is an ordinary core column and was not server-owned, so any `schema:edit`
holder could have cleared it on a salary column and read the value on the next fetch; and
one resource cannot express a link, which touches two entities that may sit in different
Areas with different grants (edit on A, none on B, create a link A→B).

The replacement is an explicit table returning a **set** of requirements, all of which must
hold:

```ts
export interface PermissionRequirement {
  /** C5 vocabulary. */
  atom: 'schema:edit' | 'sharing:manage' | 'field:viewRestricted';
  /** C5 grantable resource types. The resolver walks entity → area → project itself, so
   *  naming the most specific resource is enough. */
  resource: { type: 'project' | 'area' | 'entity'; id: Id };
}

/** Pure. `live` is the current model's index, needed to resolve an object's owning
 *  entity and its pre-patch state (old areaId, old link endpoints). */
export function requirementsOf(
  op: SchemaOperation,
  live: ModelIndex,
): PermissionRequirement[];
```

| Op | Requirements (all must hold) |
|---|---|
| create `entity` | `schema:edit` on `project`; **and** on `object.areaId` when non-null |
| update `entity`, patch contains `areaId` | `schema:edit` on the entity, **and** on the old `areaId` (if any), **and** on the new `areaId` (if any) |
| update / delete `entity` (otherwise) | `schema:edit` on the entity |
| create `field` | `schema:edit` on `object.entityId`; **and** `field:viewRestricted` on it when `object.isRestricted === true` |
| update `field`, patch sets `isRestricted: true` | `schema:edit` **and** `field:viewRestricted` on the owning entity — doc 05 R20: you must be able to see a field to classify it |
| update `field`, patch sets `isRestricted: false` | `sharing:manage` on the owning entity — doc 05 R20: de-restriction is an access-control change, not an edit |
| update / delete `field` (otherwise) | `schema:edit` on the owning entity |
| create / update / delete `index`, `constraint` | `schema:edit` on `entityId`; on an update that moves it, on the old entity too |
| create / update / delete `link` | `schema:edit` on **both** `from.entityId` and `to.entityId`; on an update that re-points an endpoint, on the old and the new entity of that side |
| create / update / delete `namespace`, `customType` | `schema:edit` on `project` |
| create / delete `area` | `schema:edit` on `project` |
| update `area` | `schema:edit` on that area |

There is no `docs:edit` branch, because `doc` is server-owned (§8.3) and documentation is
written through the docs endpoint, which checks `docs:edit` itself (§8.10). That is what
keeps a Documenter-only grant meaningful: a Documenter holds `docs:edit` and **not**
`schema:edit`, so every op in this table is refused for them, and the docs endpoint is the
only write surface they have.

### 8.6 Rules that make this safe

1. **Visibility is checked first, before versions.** An op whose target object
   `VisibilityFilter` would redact for this actor **in any way** — stub, masked, or merely
   `propsRedacted` — fails with **403** (the object is disclosed, so 403 is honest) or
   **404** (hidden: existence must not be confirmed), per doc 05 §7.10. It never reaches
   the version comparison — which is what stops a deliberately-wrong `expectedVersion` from
   being used as a read primitive.

   This rule is also what makes a whole-collection patch safe. `Index.columns` and
   `Constraint.fieldIds` are replaced wholesale by an update op, which would be exactly the
   full-list-replacement hazard doc 05 R22 forbids — except that doc 05 §8.3 marks any
   index or constraint touching a redacted field `restricted`, so this rule refuses the op
   before the list is read. Only `Field.ordinal` needs a move op (§8.4), because there the
   *entity* is visible while a *field* is masked.
2. **Then permissions** — every `PermissionRequirement` from §8.5.
3. **Ids are generated on the client** (cuid2, C1-compatible). Required so a single batch
   can create an entity and the fields that reference it, and so optimistic UI has a stable
   React key from the first frame. The server rejects an id that already exists
   (`DUPLICATE_ID`) and always sets `projectId` / `organizationId` itself — a
   client-supplied id is never trusted for tenancy. There is no stub-prefix ban: doc 05
   §7.10 deletes the HMAC stub-token scheme, so a redacted object carries its **real** id
   and there is no prefix to reject. Rule 1 is what stops a redacted client writing to an
   object it can only see as a stub.
4. **`patch.engineProps` replaces wholesale**, it is not deep-merged. Merge semantics need
   a delete-a-key sentinel and produce ambiguous diffs; the client always holds the full
   object, and the engine validates the whole bag on write regardless.
5. **The batch is atomic.** Any version conflict, permission failure or blocking validation
   error rolls the whole thing back. Partial application of a user gesture is worse than a
   retry.
6. **The server assigns `ordinal` on create.** A new field is appended:
   `max(sibling ordinals) + 1`, computed inside the transaction. Revision 1 let the client
   mint it, which meant two users adding a column to `orders` at the same moment both read
   6 as the highest and both wrote 7 — neither batch conflicted (nothing bumps the
   *entity's* version when a child is created), both committed, and the project permanently
   failed its own `ORDINAL_COLLISION` check with no database constraint able to catch it.
   With server assignment they get 7 and 8. **Reordering is a `MoveOp`** (§8.4) carrying the
   owning *entity's* `expectedVersion`, never an `update` patching `ordinal` and never a
   full ordered id list — doc 05 R22 forbids a redacted client from replacing a collection
   it was not shown in full, and doc 02 §9.3's one-check-per-gesture rule is what makes two
   concurrent reorders collide instead of interleaving. The client renders optimistically
   and the post-image corrects it.
7. **The server sorts the batch before applying**: creates ascending by `IR_OBJECT_TYPES`
   rank, deletes descending, updates in place, client order preserved within a rank. Without
   this, a client that emits its ops in any other order gets a raw database foreign-key
   violation (`fields.entity_id`, `link_endpoints.source_field_id`) instead of a typed
   error, and the whole atomic batch rolls back for a reason the user cannot act on. The
   constant already exists for `sortPath`; this is three lines and removes a class of client
   bug.
8. **Cascades are server-side, not client ops** — and they produce *modifications* as well
   as removals. Both kinds are reported:

   | Deleting | Removed | Modified (post-image in `changed`, version bumped) |
   |---|---|---|
   | a field | its descendant fields; the `index_columns`, `constraint_columns` and `link_endpoints` rows naming it | the owning `index` (shorter `columns`), `constraint` (shorter `fieldIds`), and `link` (both `fieldIds` arrays lose the same index — §8.1) |
   | an entity | its fields, indexes, constraints, and every link touching it | — |
   | a namespace or custom type | nothing — `onDelete: Restrict`; the API refuses while anything references it | — |
   | an **area** | grants and access requests scoped to it | its member entities, each with `areaId: null` |
   | any schema object | its `docs` row, its `comments`, and every `access_grant` scoped to it | — |

   **Cascade-modified objects are exempt from `expectedVersion` checking**, because the
   deleting client never held their versions. This is the fix for revision 1's worst
   convergence bug: an index, constraint or link modified by someone else's field delete
   appeared in neither `removed` nor `changed`, so every other client kept rendering a
   column that no longer existed, and every subsequent write against that object 409'd
   permanently for a reason nobody could see.

   **An emptied link endpoint does NOT delete the link.** The link survives with
   `from.fieldIds === [] && to.fieldIds === []` and becomes an entity-level link, which
   §2.7 already declares legal and `LINK_ARITY` accepts. This matches the store exactly
   (`link_endpoints` rows cascade away; the `links` row does not) and it is the less
   destructive of the two readings — dropping a column should not silently erase the
   relationship line a human drew. Revision 1 said the opposite in one clause and the
   opposite of that in another; this is the ruling.

   Because grants are deleted with their object, restoring a snapshot that recreates an
   entity with its original cuid **cannot** silently re-grant access: no orphan grant is
   left to reattach.
9. **Validation order on write.** Stated as a table, because revision 1 left engine
   validator *errors* unclassified and left the validation *scope* unstated:

   | Stage | Blocks? |
   |---|---|
   | visibility (rule 1) | yes — 403 / 404 |
   | permissions (§8.5) | yes — 403 |
   | zod shape (core, §5) | yes — 422 |
   | structural integrity (core, §11.1), **scoped** to the touched objects plus their parent scopes — the owning entity for a field/index/constraint, both endpoint entities for a link, the project for a namespace/customType/area | yes on `error` — 422 |
   | engine `propsSchemas` for the touched objects | yes — 422; the bag must parse or nothing downstream can read it |
   | engine `validator` | **never**, at any severity. Its output rides back with a successful write as canvas markers |
   | `expectedVersion` (C7) | yes — 409 |

   Full-model structural validation is reserved for snapshot load, import and the engine
   conformance suite. Running it on every 400 ms autosave at 3,000 objects is a cost two
   implementers would resolve differently, so it is stated rather than implied.

   The engine validator never blocking is what keeps "half-finished models stay saveable"
   true — you can save a column while still typing its type name. The compensating rule:
   **export and migration generation are hard-gated on a clean engine validator.** You can
   save a broken draft; you cannot emit DDL from one.

### 8.7 Realtime, retries and convergence

- **The Socket.IO frame is a `SchemaOperationResult`** (= doc 05's `IrPatch`), passed per
  recipient through `VisibilityFilter.redactPatch`. Recipients apply it with the same merge
  function the author's client used on its own result — one code path for "my write echoed
  back" and "someone else's write", which `actorUserId` distinguishes.

- **Per-recipient filtering is a visibility *transition*, not a filter.** Revision 1 said
  "objects the recipient cannot see are dropped from `changed`". That is right for an object
  that was always invisible and exactly backwards for one that just *became* invisible: user
  A sets `isRestricted = true` on `employees.salary`; user B, who lacks
  `field:viewRestricted` and has the project open, receives a frame with that field dropped,
  so B's in-memory IR keeps the previous, **fully unredacted** field — name, type, docs,
  engineProps — for the rest of the session and into any export or AI prompt B runs. The
  same hole existed for an entity moved into an Area B cannot see. The rule that closes it,
  computed per recipient over every object the batch touched, comparing visibility **before**
  and **after**:

  | Transition | Emitted to that recipient |
  |---|---|
  | invisible → invisible | nothing |
  | visible → visible | the post-image, redacted as usual |
  | hidden → visible | the full post-image in `changed` |
  | visible → masked/stub | the **redacted** post-image in `changed` — never omitted |
  | visible → hidden | a synthetic entry in `removed` |

  `removed` is never filtered: an id alone leaks nothing, and every client must converge.

- **Grant changes need their own event**, because no schema op accompanies them and the
  transition rule above therefore never fires. When a grant, role, group membership, share
  link or the project's restricted-field setting changes, the server emits
  `access-changed { projectId, generation }` to the affected principals; the client drops
  its model and refetches. Without it, a freelancer whose Area grant is revoked keeps
  rendering, exporting client-side and AI-prompting every object their browser already
  downloaded, for as long as the tab stays open. One event declared here; doc 05 §9.4 owns
  the trigger and the generation counter.

- **Reconnect and gaps.** `seq` is per-project monotonic. A client whose last-seen `seq` is
  more than one behind the frame it just received refetches the model rather than applying
  it — it cannot know what it missed.

- **Retry semantics, stated because silence is the worst option.** `batchId` is a
  correlation id, **not** an idempotency key. Revision 1 called it one while also stating
  "the server keeps no op log", and the spec's data model has nowhere to record that a batch
  was applied, so the guarantee was unimplementable as written. The rule instead: **a batch
  that times out is resolved by refetching, never by blind retry.** The client marks the
  batch in flight; on timeout it refetches the model and rebuilds its pending queue by
  diffing against its optimistic state. Blind retry is exactly the failure this prevents —
  creates come back `DUPLICATE_ID` (indistinguishable from a genuine collision) and updates
  apply twice, bumping `version` again, so the client's `expectedVersion` is permanently one
  behind and every subsequent edit 409s until reload. The refetch path already exists for
  `access-changed` and for `seq` gaps, so this reuses machinery rather than adding a table.
  The upgrade path, if measurement disagrees, is Open question 8.

- **Autosave**: the canvas store queues ops and flushes one batch on a 400 ms debounce
  (immediately for structural edits, 1 s for drag/move). One gesture, one batch, one
  activity-log row.

- **Undo/redo is client-side.** The store computes each batch's inverse from the pre-state
  it already holds, and the result's post-images give it the fresh versions for
  `expectedVersion`. The server keeps **no op log** — snapshots and the activity log are the
  history story (C8), and a server-side undo stack would be a second history mechanism
  nobody asked for. If someone else edited in between, undo 409s and the client shows
  "changed by X — reload".

- **Optimistic concurrency (C7)** is per object and comes for free: `expectedVersion` is in
  the op, the conflict response carries the (redacted) current object, and the client
  rebases the one field that collided instead of discarding the user's other edits.

### 8.8 Restore, and applying ops

```ts
/** `live` is the CURRENT live model. It supplies `expectedVersion` for every update and
 *  delete op, looked up by id — a snapshot's stored versions are frozen at capture time
 *  and stale by definition, so using them would 409 every op, roll the atomic batch
 *  back, and make restore permanently impossible. Creates carry no version.
 *
 *  THROWS if `diff.redacted || live.redacted`. */
export function opsFromDiff(diff: SchemaDiff, live: SchemaModel): SchemaOperation[];

/** Pure, immutable, structural sharing. Created objects get `version: 0` and, for
 *  fields, `ordinal = max(siblings) + 1`; updated objects get `version + 1` — matching
 *  the server's write path exactly, which is what lets the server-side applier be
 *  property-tested against this function. */
export function applyOps(model: SchemaModel, ops: SchemaOperation[]): SchemaModel;

export function mergeResult(model: SchemaModel, result: SchemaOperationResult): SchemaModel;
```

Restore is `opsFromDiff(diffModels(live, snapshot), live)` submitted as one batch, so it
goes through the same validation, permission and broadcast path as hand editing instead of
being a privileged bulk overwrite. Three rules make that safe, and revision 1 stated none of
them:

1. **Restore is computed server-side on unredacted models only**, and `opsFromDiff` throws
   on a redacted input. If `live` were the *actor's* redacted model, an Editor scoped to the
   Billing Area would restore a snapshot and see every entity outside Billing as `removed` —
   and `opsFromDiff` would emit deletes for the entire rest of the project, atomically,
   through the ordinary write path, hard-deleted per C8.
2. **Restore requires `schema:edit` at *project* scope**, not area or entity scope. It is a
   whole-model operation and cannot be meaningfully partial.
3. **Every emitted op still goes through §8.6**, including rule 1's visibility check, so
   even a project-scoped editor cannot restore over an object they may not see.

Restore is therefore a read-then-write that can itself 409 if someone edits mid-restore.
That is correct behaviour and must surface as "project changed — re-run restore", not as a
partial application.

### 8.9 Snapshots

`snapshots.ir` stores `SchemaModelSchema.parse(assembleModel(...))` as JSON, with
`irVersion` inside the blob. Snapshots are always stored **unredacted**; a snapshot shown to
a user is redacted on read like everything else (§10).

```ts
/** Upgrades an old snapshot blob to the current irVersion, then parses it. A plain
 *  switch on `blob.irVersion` — empty in v1, and the seam that makes those blobs safe to
 *  keep forever. Throws on a missing, unknown or future irVersion. */
export function upgradeModel(blob: unknown): SchemaModel;
```

### 8.10 Documentation writes

`doc` is server-owned (§8.3), so documentation never flows through `SchemaOperationBatch`.
The docs module owns `PUT /projects/:id/docs/:targetType/:targetId`, carrying TipTap
`JSONContent` and the structured facts; it checks `docs:edit` itself, derives `plainText`
and the excerpt, and then emits a **`SchemaOperationResult`-shaped frame** whose `changed`
carries the post-image of the documented object with its refreshed `DocRef`. Realtime and
the client's merge path therefore stay single: one frame type, one merge function, one
subscriber.

### 8.11 Canvas geometry — the one write that is not an op

`POST /projects/:projectId/schema/geometry`, body
`{ entities: { id: Id; position: Point; width?: number; height?: number }[] }`.

**It does not read and does not bump `version`, and it is last-write-wins by design**
(doc 02 §10.4, the C7 carve-out). One auto-layout rewrites 300 positions in a single
gesture; if that bumped 300 versions, every other client with an open property panel — a
rename in progress, a nullable toggle — would 409 on a change that conflicted with nothing,
and two people panning the same project would 409 each other's *semantic* edits
continuously. §7.4 already classifies `position` / `width` / `height` as `cosmetic`, so the
diff and the migration generator ignore them either way.

It still goes through the full guard: `schema:edit` on each named entity, rule 1's
visibility check, and doc 05's autolayout rule (`schema:edit`, **not** R21′ — it lays out
`visibleEntityIds` only and leaves every other entity's position untouched). It broadcasts a
`SchemaOperationResult`-shaped frame like everything else, on a lower-priority channel, so
the client's merge path stays single. `UpdateOp.patch` cannot name a geometry key (§8.4).

This answers what was Open question 3.

---

## 9. Traversal and query helpers

Core needs lookups the raw maps do not give cheaply. They live behind one index, declared
honestly — revision 1 declared `ModelIndex` as `{ readonly model: SchemaModel }` while its
closing paragraph described nine internal structures and three memoized derivations, so none
of the ~20 free functions taking `ix: ModelIndex` could reach anything and the memoization
had nowhere to live.

```ts
export interface ModelIndex {
  readonly model: SchemaModel;
  readonly normalizeName: NormalizeName;

  // Built in one O(n) pass by createIndex. Arrays are pre-sorted by ordinal, then by id
  // for stability. Name keys are normalized.
  readonly fieldsByEntity: ReadonlyMap<Id, readonly Field[]>;
  readonly fieldsByParent: ReadonlyMap<Id, readonly Field[]>;   // key: parentFieldId
  readonly fieldsByCustomType: ReadonlyMap<Id, readonly Field[]>;
  readonly entitiesByNamespace: ReadonlyMap<Id, readonly Entity[]>;
  readonly entitiesByArea: ReadonlyMap<Id, readonly Entity[]>;
  readonly entityByQualifiedName: ReadonlyMap<string, Id>;      // `${ns}.${name}`
  readonly indexesByEntity: ReadonlyMap<Id, readonly Index[]>;
  readonly constraintsByEntity: ReadonlyMap<Id, readonly Constraint[]>;
  readonly constraintsByField: ReadonlyMap<Id, readonly Constraint[]>;
  readonly linksByEntity: ReadonlyMap<Id, readonly Link[]>;     // both directions
  readonly linksByField: ReadonlyMap<Id, readonly Link[]>;
  readonly adjacency: ReadonlyMap<Id, readonly Id[]>;           // entity -> neighbours
  readonly logicalKeys: Readonly<Record<IrObjectType, ReadonlyMap<Id, string>>>;
  readonly defaultNamespaceId: Id;

  /** Lazy derivations, computed on first call and cached here. Mutable slots on an
   *  otherwise readonly structure — deliberate, and the only mutation in the package. */
  joinPathCache: Map<string, JoinPath[]>;
  topoCache: { order: Id[]; cycles: Id[][] } | null;
}

export function createIndex(model: SchemaModel, opts?: IndexOptions): ModelIndex;

/** Memoized: WeakMap<SchemaModel, ModelIndex>, IDENTITY normalizer only. Because models
 *  are replaced immutably on every edit, the cache invalidates itself and cannot go
 *  stale. Callers that need engine name folding build and hold their own index with
 *  `createIndex(model, { normalizeName })` — see §6.3. */
export function indexOf(model: SchemaModel): ModelIndex;
```

```ts
// --- identity / lookup -----------------------------------------------------
export function get<T extends IrObjectType>(
  model: SchemaModel, type: T, id: Id,
): IrObjectMap[T] | undefined;

export function getEntity(ix: ModelIndex, entityId: Id): Entity | undefined;
export function entitiesOf(ix: ModelIndex, namespaceId: Id): Entity[];  // name order
export function entitiesOfArea(ix: ModelIndex, areaId: Id): Entity[];
/** Compares through `ix.normalizeName`, so with the PostgreSQL engine's folder
 *  `findEntityByName(ix, 'public', 'Orders')` finds `orders`. This is the lookup the
 *  Phase-2 queryValidator resolves parsed SQL identifiers against (spec 6.3 step 6),
 *  which is why it is not exact-match and why the engine does not need a second index. */
export function findEntityByName(
  ix: ModelIndex, namespace: string, name: string,
): Entity | undefined;

// --- fields ----------------------------------------------------------------
export function fieldsOf(
  ix: ModelIndex,
  entityId: Id,
  opts?: { parentFieldId?: Id | null; recursive?: boolean },
): Field[];                                   // always ordered by ordinal
export function fieldDepth(ix: ModelIndex, fieldId: Id): number;
export function fieldPath(ix: ModelIndex, fieldId: Id): FieldPath;
export function fieldNamePath(ix: ModelIndex, fieldId: Id): FieldNamePath;
export function resolveNamePath(
  ix: ModelIndex, entityId: Id, names: FieldNamePath,
): Field | undefined;

// --- derived badges (the single source for PK / FK / UNIQUE) ---------------
export function primaryKeyFields(ix: ModelIndex, entityId: Id): Field[];
export function isPrimaryKey(ix: ModelIndex, fieldId: Id): boolean;
export function isUniqueField(ix: ModelIndex, fieldId: Id): boolean;
export function isForeignKeyField(ix: ModelIndex, fieldId: Id): boolean;
export function constraintsOf(ix: ModelIndex, entityId: Id): Constraint[];
export function indexesOf(ix: ModelIndex, entityId: Id): Index[];

// --- graph -----------------------------------------------------------------
export function linksOf(ix: ModelIndex, entityId: Id, dir?: 'out' | 'in' | 'both'): Link[];
export function linksTouchingField(ix: ModelIndex, fieldId: Id): Link[];
export function neighbours(ix: ModelIndex, entityId: Id): Id[];

export interface JoinStep {
  linkId: Id;
  fromEntityId: Id;
  toEntityId: Id;
  direction: 'forward' | 'reverse';      // forward = child -> parent
  fieldPairs: [Id, Id][];                // positional endpoint pairs
}
export interface JoinPath { from: Id; to: Id; steps: JoinStep[]; cost: number }

/** Shortest-first BFS over the link graph. Defaults: maxDepth 4, limit 5.
 *  cost = number of steps, +1 per N:M hop (an unresolved many-to-many needs a
 *  junction). Deterministic: equal-cost paths sort by the concatenated logical keys of
 *  their steps, so the AI's suggestion list never reshuffles between calls. */
export function joinPaths(
  ix: ModelIndex,
  from: Id,
  to: Id,
  opts?: { maxDepth?: number; limit?: number; allowed?: Set<Id> },
): JoinPath[];
```

`opts.allowed` is how spec 6.3 step 4 works: the AI module passes the set of entities the
user may see, gets back paths that traverse only those, and diffs a path's entities against
the user's selection to offer "add `order_items` to include this join".

```ts
// --- export ordering -------------------------------------------------------
/** Kahn's algorithm over link dependencies (child depends on parent) plus
 *  TypeRef.customTypeId edges. Deterministic tie-break by logical key.
 *  Cycles are NOT an error (self- and mutual foreign keys are legal): their members are
 *  appended in logical-key order and reported, so the exporter knows to emit those
 *  foreign keys as trailing ALTER statements. */
export function topologicalEntityOrder(ix: ModelIndex): { order: Id[]; cycles: Id[][] };

// --- identity strings ------------------------------------------------------
export function logicalKey(ix: ModelIndex, type: IrObjectType, id: Id): string;
export function byLogicalKey(ix: ModelIndex, type: IrObjectType): Map<string, Id>;
```

---

## 10. The redacted IR

### 10.1 Who owns what

Doc 05 is the security authority (spec §5, and its G1–G5 guarantees are directly testable).
Revision 1 of this document wrote its own redaction *rules*, and they contradicted doc 05 on
every substantive point: what a masked field retains, whether ordinals are renumbered,
whether stub ids are real ids, whether an index over masked fields survives, and how the
mark is spelled. That is not an acceptable state for the permission boundary this design
pass exists to get right — one of the two documents was describing a system that would not
be built. The split, stated once:

> **Doc 05 §7.10 and §8.3 own the redaction rules — which objects survive, in what state.
> This document owns the *shape* those rules must produce, and guarantees that the shape is
> expressible as a valid `SchemaModel`.**

Where the two disagreed, doc 05 wins, and this document changed:

| Point | Revision 1 said | Now |
|---|---|---|
| Hidden field ordinals | gaps kept; "the validator must not complain" | **densely renumbered `0…n-1`** (doc 05 L22). A gap *is* the leak: it says "a column you cannot see sits here". §11.1's gap exemption is deleted. |
| Masked field content | keeps name, ordinal, type, nullability | **keeps `id`, `entityId`, `parentFieldId` and `ordinal`** — the slot and its place in the tree — plus the mark; `name`, `type`, `isNullable`, the governance flags (`isRestricted`, `isPii`, `isDeprecated`), `doc` and `engineProps` are all blanked to constants (doc 05 §7.10) |
| Stub / masked ids | the real cuid | **the real cuid** — doc 05's HMAC stub-token scheme is deleted (its §7.10): a cuid carries no name, ids do not correlate across projects, every route already 404s an id the subject cannot see, and the tokens broke "Request access" (which needs a real target) and field reorder (whose `beforeFieldId` is frequently the masked column) |
| Index/constraint over only-masked fields | kept, "so the PK badge still renders" | **replaced by a column-less stub** in `mask` mode, omitted in `hide` mode (doc 05 §8.3). Both documents agree it is kept; doc 05 §8.3 adds what does not survive: `name: ''` (no `idx_emp_salary`), `engineProps: {}`, expression columns dropped and the survivors renumbered densely, `columns: []` where nothing survives, and the object marked restricted. The stub is what renders the badge, and it renders nothing else. |
| `RestrictionMark { level }` | a wrapper object with two levels | **`restricted?: RestrictionMark`, three levels** — `'stub' \| 'masked' \| 'propsRedacted'` (§2.2). Revision 2 briefly flattened this to `restricted?: true` on the grounds that nothing branched on the level; doc 05's R27 does: a fully visible object whose `engineProps` were blanked renders "some properties are hidden from you", not a lock badge, and the exporter must skip a stub while keeping a `propsRedacted` object. The level is load-bearing after all. |
| "Request access to this table" | justified keeping a stub's real `kind` and `namespaceId` | **upheld for `id` and `kind`, overridden for `namespaceId`.** A stub carries its **real** `id` and its real `kind` (§10.2) — the HMAC/`stubKey` token scheme is deleted, so there is no opaque id to translate. Its `namespaceId` is the project's default namespace instead of the real one, because a namespace name is itself a name to blank (§10.2 rule 4). Request-access is doc 05's `access_requests` flow, keyed by that real id. |
| Redaction file | not mentioned | `packages/schema-model/src/redact.ts` is **this package's file** (§0.1): doc 05 §8.6 requires the brand, the hash-private `RawSchemaModel` and `redact` itself to share one module, and C10 puts that module here |
| Expression leaks (CHECK bodies, partial predicates, defaults, generated columns, expression indexes) | not addressed — `engineProps` shipped verbatim | **`IrBase.refs`** (§2.2) plus doc 05's R27: if any referenced object is invisible, `engineProps` is blanked, expression columns are dropped and the object is marked `propsRedacted` |

### 10.2 The shape contract

```ts
// packages/schema-model/src/redact.ts — ONE module holds the box and the only key

/** Compile-time single-path enforcement, required by doc 05 §8.6: every serializer
 *  (exporter.export, aiProfile.serializeContext, defaultJoinPaths, queryValidator.validate,
 *  the IR DTO mapper, the snapshot writer) takes this type, so a raw model cannot reach
 *  them by accident. A PHANTOM brand, not `SchemaModel & { redacted: true }` — the latter
 *  is a structural narrowing that `{ ...model, redacted: true }` satisfies, so any code
 *  could forge one without a cast, and the "compiler says it" claim would be false. The
 *  runtime marker is the ordinary `redacted: true` field the model already carries. */
declare const REDACTED: unique symbol;
export type RedactedModel = SchemaModel & { readonly [REDACTED]: true };

/** The only thing SchemaLoader returns. The payload is genuinely unreachable — a hash-
 *  private field with no accessor, in the same module as its only reader — so
 *  `return raw.ir` does not compile and an accidental serialisation throws instead of
 *  leaking. Doc 05 §8.6 argues this at length; the earlier `readonly ir: SchemaModel`
 *  public field enforced nothing. */
export class RawSchemaModel {
  readonly #model: SchemaModel;
  constructor(model: SchemaModel) { this.#model = model; }
  /** Any accidental serialization fails loudly instead of leaking. */
  toJSON(): never { throw new Error('raw_ir_escaped'); }
  /** Module-private; not exported from the package index. `redact` is its only caller. */
  static [UNWRAP](raw: RawSchemaModel): SchemaModel { return raw.#model; }
}

/** Doc 05 §8.1 owns `VisibilityContext` and the rules; this package owns the shape and is
 *  the only producer of a `RedactedModel`. Pure: no I/O, no clock. */
export function redact(raw: RawSchemaModel, ctx: VisibilityContext): RedactedModel;
export function redactPatch(patch: IrPatch, ctx: VisibilityContext): IrPatch | null;

/** Blanking constants. Redaction replaces a value with a CONSTANT; it never removes a
 *  required key — that is what keeps a redacted model parseable by the same zod schemas
 *  and renderable by the same canvas. Because the constant is identical for every
 *  redacted object, it carries zero information and doc 05's G1 holds. */
export const BLANK = {
  name: '',
  kind: '',
  engineProps: {} as Record<string, unknown>,
  doc: null,
  type: { name: '' } as TypeRef,
  fieldIds: [] as Id[],
  columns: [] as IndexColumn[],
} as const;
```

Compatibility rests on five rules and nothing else. `VisibilityFilter` must satisfy all
five; the engine conformance suite asserts them.

1. **`SchemaModel.redacted = true` at the root**, and `RedactedModel` is the branded type.
   Clients disable edit, export and snapshot affordances; the server re-checks anyway;
   `opsFromDiff` throws (§8.8).
2. **Every object may carry `restricted?: RestrictionMark`** — optional, so a full model is
   also a valid redacted model (of a user who can see everything).
3. **Redaction only removes objects and blanks properties to the constants above**, and
   densely renumbers the two ordinal spaces that a removal can leave gapped: a field's
   `ordinal` within its `(entityId, parentFieldId)` sibling group (doc 05 L22), and an
   index's surviving `columns[].ordinal` after expression columns are dropped (doc 05 §8.3)
   — otherwise `ORDINAL_COLLISION` fires on data working as designed. Ids are **never**
   rewritten. It never adds a collection, changes a type, or reorders anything else.
4. **`validateModel` must return no `error` on the output of `VisibilityFilter`.** This is
   the rule revision 1 violated three ways over, so that a viewer opening a project where an
   FK target column is restricted would have had the client (or the server, before
   broadcast) log validation errors on data working as designed. Three specific obligations
   follow, and they are why the rules below are phrased as they are:
   - **Links.** Three cases, and the distinction matters because array index **is** the
     pairing (§2.7):
     - *Endpoint entities both visible, some endpoint field masked* — the masked field
       object is still in `objects.field` under its real id, so **`fieldIds` are left
       exactly as they are**; arity and pairing are preserved for free. The link's own
       `name` and `engineProps` are blanked (they hold `fk_orders_employee_salary` and the
       constraint name — doc 05 L2) and it is marked `{ level: 'masked' }`.
     - *Either endpoint entity is a stub, or any endpoint field is hidden* — a stub entity
       has no fields at all, so **both** sides' `fieldIds` are cleared to `[]` **together**,
       `name` and `engineProps` are blanked, and the link is marked `{ level: 'stub' }`,
       degrading it to an entity-level link.
     - *Both endpoint entities invisible* — the link is absent.

     What must never happen is "drop the hidden ids from `fieldIds`": on a composite FK
     where the reader can see the child column but not the parent that produces
     `from.fieldIds.length !== to.fieldIds.length` (a `LINK_ARITY` error) *and* silently
     re-pairs every subsequent column with the wrong counterpart.
   - **Namespaces.** The project's **default namespace is always present** in a redacted
     model, and every **stub** entity carries its id rather than its real one. A namespace
     survives only when it holds at least one *visible* entity. Both halves are needed: a
     stub carrying its real `namespaceId` either dangles (if the namespace was dropped) or
     keeps a namespace alive purely to host a stub — and a namespace name like
     `payroll_private` **is a name**, which is the thing §10 exists to blank. The default
     namespace's name (`public`) is not a secret: it is the same for every project and
     visible to anyone who may open one. This overrides doc 05 §8.3's "kept if it contains
     at least one surviving entity (stub or full)", which leaked exactly that name.
   - **Custom types.** A masked field's `type` is blanked to `BLANK.type`, so `customTypeId`
     is `undefined` and nothing dangles. Custom types are retained per doc 05 §8.3 (kept if
     the subject can see any entity), so a visible field's `customTypeId` resolves too.
5. **Ids are real.** A redacted object keeps the cuid of the row it stands for, so links
   point somewhere, "Request access to this table" (doc 05 §7.13) has a target, and a
   redacted client's `beforeFieldId` can name a masked column. Confidentiality lives
   entirely in the blanked *properties*. Doc 05 §8.5 has the authoritative examples; the
   three shapes below are the same objects written against this package's types.

Blanked objects, for reference — each is a full, schema-valid object. `version: 0` is a
constant because a real version is an edit-activity signal:

```ts
// stub entity (invisible, but referenced by a link whose other end is visible)
{ id: realId, name: '', version: 0, engineProps: {},
  namespaceId: defaultNamespaceId,   // never the real one — see rule 4 below
  kind: <REAL: shape only, says nothing about content>,
  areaId: null,                      // a stub never keeps an Area alive (doc 05 §8.3)
  position: { x, y },                // REAL: the diagram must not reflow per viewer
  color: null, doc: null,
  restricted: { level: 'stub' } }

// masked field (project restrictedFieldMode === 'mask')
{ id: realId, name: '', version: 0, engineProps: {},
  entityId: <REAL>, parentFieldId: <REAL — the tree must stay walkable>,
  ordinal: <its position after dense renumbering within its sibling group>,
  type: { name: '' }, isNullable: true,
  isRestricted: true, isPii: false, isDeprecated: false, doc: null,
  restricted: { level: 'masked' } }

// index or constraint that survives only to render a badge
{ id: realId, name: '', version: 0, engineProps: {},
  entityId: <REAL>, kind: <REAL>, isUnique: false, columns: [],
  restricted: { level: 'masked' } }

// fully visible field whose DEFAULT referenced a restricted column (doc 05 R27)
{ ...theRealField, engineProps: {}, restricted: { level: 'propsRedacted' } }
```

Also: **an entity whose constraints or indexes were dropped or stubbed by redaction is
itself marked `restricted: true`.** Without it, a table whose primary-key column is
restricted-hidden survives as an ordinary, *unmarked* entity with its PK constraint silently
missing — and "exports respect permissions" (spec 6.4) then produces DDL for a table with no
primary key. It runs, it creates a table, and the result is subtly wrong rather than
obviously refused.

### 10.3 Consequences, stated so nobody rediscovers them in review

- **AI never sees a restricted anything.** Doc 05 §7.10 settles it at the source: a masked
  field is "never included, in either mode". The AI module serializes the redacted model as
  given; there is no parameter to pass. (Revision 1 told the AI module to pass `mask:
  'hide'` to an API that exists in neither document.)
- **Editing is refused server-side**, not merely hidden: §8.6 rule 1 checks visibility before
  anything else and returns 403/404. The `restricted` mark is a rendering hint, never a
  security boundary.
- **Diffing two redacted models is legal** (a viewer comparing snapshots) and produces a diff
  of what that viewer can see. `SchemaDiff.redacted` is set and `opsFromDiff` refuses it.
  Stub-versus-stub compares equal, because every leaking property is blanked to a constant
  and the id is the real, stable row id.
- **Exports run on the redacted model** (spec 6.4). The rule for engines, stated once here so
  the conformance suite can test it: **an object marked `stub` or `masked` is never
  emitted** — the exporter skips it and every link touching it, and emits one un-quantified
  notice line (doc 05 L11) rather than a count or a name. An object marked `propsRedacted`
  **is** emitted, without its `engineProps`: it is a real, visible object whose expression
  was withheld, and the same un-quantified notice covers the loss.
- **The conformance suite asserts rule 4 directly**, on a model with (a) a hidden primary-key
  column, (b) a hidden FK endpoint on a composite link, and (c) a hidden field typed by a
  custom type. `validateModel(redact(model, ctx))` must return no errors for all three, in
  both `mask` and `hide` modes.

---

## 11. Validation: what this package checks, and what it does not

### 11.1 Structural validation (schema-model)

Engine-free invariants — the ones true for MongoDB and PostgreSQL alike.

```ts
export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;                       // 'DANGLING_REFERENCE', 'ORDINAL_COLLISION', …
  message: string;
  objectType: IrObjectType;
  objectId: Id;
  /** Path inside the object, when the issue is about one property. */
  path?: readonly string[];
}

export interface ValidateOptions {
  normalizeName?: NormalizeName;                 // §6.3; default identity
  /** Restrict the scan to these objects and their parent scopes — what the write path
   *  passes (§8.6 rule 9). Omitted = whole model. */
  scope?: { type: IrObjectType; id: Id }[];
}

export function validateModel(
  model: SchemaModel, opts?: ValidateOptions,
): ValidationIssue[];
```

`engine-sdk` re-exports this exact type for engine validators, so the UI has one issue list,
one marker renderer and one severity scale.

Checks, all O(n) over the index:

| Code | Rule | Severity |
|---|---|---|
| `ID_COLLISION` | an id appears in two collections | error |
| `KEY_MISMATCH` | `objects.T[id].id !== id` | error |
| `DANGLING_REFERENCE` | an `entityId` / `namespaceId` / `parentFieldId` / `areaId` / `customTypeId` / `fieldIds[]` / `columns[].fieldId` does not resolve | error |
| `FIELD_PARENT_CYCLE` | the `parentFieldId` chain loops | error |
| `FIELD_PARENT_ENTITY` | a child field's `entityId` differs from its parent's | error |
| `FIELD_DEPTH_EXCEEDED` | nesting deeper than `MAX_FIELD_DEPTH` (8) | error |
| `ORDINAL_COLLISION` | siblings (same entity + same parent) do not form a dense `0…n-1` set, or an index's columns do not | error |
| `NAME_COLLISION` | duplicate name **after `normalizeName`** in scope: entities per namespace, fields per parent scope, indexes and constraints per entity, custom types per namespace, namespaces and areas per project. Objects carrying `restricted` are skipped. | error |
| `DUPLICATE_LOGICAL_KEY` | two objects of one type produce the same logical key | **warning** |
| `LINK_ARITY` | `from.fieldIds.length !== to.fieldIds.length` | error |
| `LINK_FIELD_OWNER` | an endpoint's field does not belong to that endpoint's entity | error |
| `ENGINE_PROPS_SHAPE` | `engineProps` is not a plain object | error |
| `INDEX_COLUMN_SOURCE` | an `IndexColumn` has neither or both of `fieldId` / `expression` | error |
| `EMPTY_NAME` | a `namespace`, `entity`, `field`, `customType` or `area` has an empty name and is not marked `restricted` (links and constraints are legitimately unnamed) | warning |

Five changes from revision 1, each because the check was wrong rather than merely strict:

- **`DUPLICATE_LOGICAL_KEY` is a warning.** Pass 2 of the matcher already handles a collision
  by leaving both sides unmatched, so a duplicate key is a degraded match, never a corrupt
  model — and with the key made total (§6.1) it should now be unreachable on data the
  product accepts. As an error it meant `validateModel` rejecting legal PostgreSQL (two
  table-level CHECKs on one table), which failed the flagship import workflow on the first
  real DDL file.
- **`ID_SHAPE` is deleted.** It asserted the cuid charset at `error` severity while
  `IdSchema` two sections away accepted any 1–64 character string, and it would have rejected
  readable seed-script ids (spec §10 requires a seed script) and any future id
  migration — a validator failing on data the team deliberately created. `ID_COLLISION`,
  `KEY_MISMATCH` and `DANGLING_REFERENCE` already do the work it pretended to.
- **`ENGINE_PROPS_REFERENCE` is deleted.** It scanned every `engineProps` leaf string against
  the model's live id set on every validation, on the write path, at 3,000 objects, to emit
  a warning that revision 1 itself admitted is really enforced by code review of each
  engine's `propsSchemas`. It would fire approximately never and be ignored when it did. The
  rule (§2.1) stands; its enforcement is the `engine-sdk` conformance checklist.
- **`LINK_EMPTY_ENDPOINT` is merged into `LINK_ARITY`.** "One side has fields and the other
  does not" *is* an arity mismatch; two codes for one condition split implementers, and the
  old `LINK_ARITY` wording ("while both are non-empty") left the asymmetric case at warning
  severity where it belongs at error.
- **`ORDINAL_COLLISION` now checks density, not just uniqueness.** Ordinals are dense
  `0…n-1` by construction: the server assigns them on create (§8.6 rule 6) and redaction
  renumbers densely (§10.1). Revision 1 had to tolerate gaps precisely because its redaction
  produced them; that exemption is gone with the cause.

Link cycles are still not an error — self-referencing and mutually-referencing foreign keys
are legal, so they are reported by `topologicalEntityOrder().cycles` as information for the
exporter, never as a validation failure.

**`validateModel` must pass on the output of `VisibilityFilter`** (§10.2 rule 4). That is a
testable obligation on the filter, not a caveat on the validator.

### 11.2 What the engine validates instead

`EngineDefinition.validator` owns everything needing a catalogue or a parser: type names and
parameters against `typeCatalog`; identifier length and reserved words; legal `kind` values
(including rejecting the empty string on a live model); empty type names; `engineProps`
against `propsSchemas`; illegal combinations ("a view cannot have a primary key", "a GIN
index needs a supported opclass", "an identity column cannot also have a default"); and
cardinality legality for the paradigm.

Case-insensitive name collisions are **no longer** solely the engine's problem: core takes
`normalizeName` (§6.3) and folds inside `NAME_COLLISION`, `logicalKey` and every name
lookup, because the matcher that decides insert-versus-update on import is core code. The
engine still owns the folding *rule*; core owns applying it consistently.

Split test: *could a reviewer decide this rule without knowing the engine?* Yes → here.
No → engine.

---

## 12. Size and performance

Target from spec 6.1: 300+ entities stay smooth. Working numbers: 300 entities, ~3,000
fields, ~400 links, ~600 indexes and constraints.

| Part | Size |
|---|---|
| Structure (objects, no docs) | ~1.5 MB JSON |
| Doc excerpts at 100% coverage: ~3,300 documented objects × ≤200 chars plus the `DocRef` wrapper | ~0.8 MB |
| **Total worst case** | **~2.3 MB JSON, ~250 KB gzipped** |

The excerpt cap is what keeps that second row bounded, and revision 1 had no cap: it shipped
the full flattened `plainText` plus `FieldDocFacts` (`allowedValues` and `examples` arrays)
for every documented object, while quoting a 1.5 MB budget computed from structure alone. A
project at the coverage meter's own target — a paragraph per field — is several megabytes of
prose shipped on every project open, held in every client's memory, filtered per recipient on
every broadcast, and frozen into every snapshot row forever. The same reasoning that kept
TipTap JSON out of the IR applies to the flattened text. Full text lives server-side; search
is a server query.

What the package provides, and nothing more:

1. **O(1) lookups by construction.** The normalized container (§1) is the main performance
   decision in this document — no scans to find an object, anywhere.
2. **One index build, memoized on a `WeakMap<SchemaModel, ModelIndex>`.** A full build over
   the working set is a single pass, low single-digit milliseconds. Because edits replace the
   model object immutably, the cache invalidates itself; there is no invalidation code to get
   wrong.
   ```
   ponytail: full index rebuild per edit, not incremental. At ~3k objects it is
   irrelevant. If a profiler ever disagrees, add a revision counter and patch the
   affected buckets — the index interface does not change.
   ```
3. **Structural sharing in `applyOps` / `mergeResult`.** Only the touched object and its
   collection record are replaced, so `React.memo` on entity cards holds and a 300-card
   canvas re-renders one node per keystroke.
4. **zod parsing at trust boundaries only** (§5). Parsing a full model costs tens of
   milliseconds and buys nothing on data we just assembled from our own rows.
5. **Scoped structural validation on the write path** (§8.6 rule 9); full-model validation
   only on snapshot load, import and conformance.
6. **Diff cost is O(n) matching plus O(changed) deep diffs.** With the rename heuristic
   deleted (§7.3) there is no quadratic step left at all. `sortPath` is precomputed, so
   re-sorting or re-filtering in the browser is a string sort with no model access.
7. **Laziness where it is free.** `joinPaths` and `topologicalEntityOrder` are computed on
   first call and cached on the index — the AI needs the first and the exporter the second,
   rarely in the same request.

Deliberately not provided: no partial or paged IR, no virtualization (the canvas layer owns
that), and no server-side IR cache in Redis — assembly is twelve indexed queries, and caching
a permission-derived model is a cache-invalidation problem nobody needs in Phase 1.

---

## Key decisions

1. **Normalized maps keyed by id, no nesting in the stored shape.** The diff, canvas
   memoization, row assembly and realtime patching all become O(1) lookups, and the only
   thing lost — child ordering — was already mandated as an explicit `ordinal` by C11.
2. **Collections keyed by the singular type name (`objects.entity`).** Lets every generic
   routine be written once over `IrObjectType` with no irregular-plural mapping table and no
   casts.
3. **"Core iff engineless code reads it."** A decidable rule for the core versus
   `engineProps` split, with the consumers of "engineless code" enumerated so a reviewer can
   apply the rule instead of arguing about it. Core properties are explicitly *not* assumed
   equal to the relational columns: §8.1 prints the real per-type mapping and names the three
   columns doc 02 must add.
4. **`engineProps` may never reference another IR object.** Otherwise core cannot validate,
   cascade or redact it — which is why `IndexColumn.role`, `TypeRef.customTypeId` and
   `LinkEndpoint.fieldIds` are core structures, and why `index_columns` needs an `is_include`
   column rather than an engineProps array of field ids.
5. **`TypeRef` is core and structured (`name` / `args` / `dimensions` / `customTypeId`), with
   no rendered `display`.** Core must search and diff types structurally; a denormalized
   rendered label would have to be minted by the client on every write while the server also
   computed it, so the two renderers drift and the stored value depends on who wrote last.
   Type badges are engine UI (spec 3.3), which also makes assembly engine-free.
6. **A foreign key is a `Link`, not a `Constraint`.** One user-visible concept, one object,
   no synchronization problem between two representations of the same thing. One
   `link_endpoints` row carries both field ids, so composite pairing cannot shift.
   `LinkEndpoint.role` is deleted: unpersistable and redundant with `Link.name`.
7. **Kinds are plain `string` in core; engines narrow them with type guards.** The `OpenKind`
   helper and its five aliases are deleted — `z.infer` produced plain `string` anyway, so
   they never appeared in a single IR type.
8. **Field nesting is flat with `parentFieldId`, and nothing else nesting-related ships in
   Phase 1.** `parentFieldId`, the cycle check, the entity-ownership check and
   `MAX_FIELD_DEPTH` stay (the column exists and retrofitting integrity is what this pass
   prevents); `FieldNode`, `fieldTree` and the name-path escaping apparatus are deferred to
   the first engine that sets `supportsNestedFields: true`.
9. **Ids address fields; name paths render them.** `address.geo.lat` is a display string,
   `[id, id, id]` is the identity, so comments, grants and diffs survive renames.
10. **zod first, types inferred, all eight object schemas written out in full.** One
    definition per type, `FooSchema` / `Foo` naming, parsing at trust boundaries only. The
    two shapes zod cannot express (`SchemaOperation`, `SchemaDiff`) are named as exceptions
    rather than left implicit.
11. **Logical keys are total and injective per object type**, including for column-less
    constraints, column-less links and redacted stubs. `DUPLICATE_LOGICAL_KEY` is therefore a
    warning: a collision is a degraded match, not a corrupt model.
12. **Exactly one id type, `Id`.** The ten per-object aliases were all `= string`, so
    TypeScript accepted any of them anywhere; parameter names document the same thing for
    free.
13. **One `SchemaDiff` serves the visual diff and the migration generator**, with selectors
    (`entriesByEntity`, `entriesOfType`, `destructiveEntries`) instead of a second type.
14. **The diff is one flat, `sortPath`-sorted array discriminated by `objectType`**, with
    every `sortPath` segment defined, percent-encoded, and shown in a worked example per
    object type.
15. **Matching is id → logical key → human-pinned pairs. There is no rename heuristic.**
    Revision 1's weights could not detect an entity rename at all (max 0.50 against a 0.6
    threshold) and could exceed their own documented confidence range; the confirm-rename
    screen they feed is undesigned and belongs to Phase 4. An applied rename has exactly one
    representation: a `changed` entry with a `name` property change, so a rename that also
    changed the type no longer loses the type change.
16. **Four severities, and `governance` is the new one.** `isRestricted`, `isPii` and
    `areaId` change who can see an object or assert something compliance-relevant; they emit
    no DDL but must never be dropped by `ignoreCosmetic`, which is what the history UI's
    default filter and the migration generator both pass.
17. **Core never decides what is destructive** — except that removing a namespace, entity,
    field or custom type always is.
18. **Rows are the truth; a typed `SchemaOperation` batch is the only write path; the IR is
    the read model.** One transaction per user gesture, one place for permission and version
    checks, and the batch result doubles as the realtime frame and as the input to the
    client's optimistic merge.
19. **`version`, `restricted`, `refs` and `doc` are server-owned; `ordinal` is server-assigned on
    create.** A patchable derived `doc` would let a client forge search results and AI
    context; a client-minted `ordinal` let two simultaneous column adds both write 7 and put
    the project into permanent validation failure with no database constraint to catch it.
20. **Permission requirements are an explicit op × patched-keys table returning a set**,
    including `sharing:manage` to clear `isRestricted`, `field:viewRestricted` to set it, and
    `schema:edit` on **both** endpoint entities of a link.
21. **Visibility is checked before versions, and `VersionConflict.current` is redacted.**
    Otherwise a deliberately-wrong `expectedVersion` is a read primitive for any object whose
    entity the actor may edit but whose contents they may not see.
22. **Cascades report modifications as well as removals, and cascade-modified objects skip
    `expectedVersion`.** Without it, an index, constraint or link touched by someone else's
    field delete desyncs every other client permanently. An emptied link endpoint degrades
    the link to entity-level; it does not delete it.
23. **`batchId` is a correlation id, not an idempotency key; timeouts are resolved by
    refetching.** There is nowhere to record applied batches, and claiming a guarantee that
    cannot be implemented is worse than either honest alternative.
24. **Restore is server-side, unredacted, project-scoped, and `opsFromDiff` throws on a
    redacted input; `expectedVersion` comes from the live model.** On the actor's redacted
    model it would have emitted deletes for every object outside their grant, atomically and
    irreversibly; on the snapshot's frozen versions it would have 409'd every op and never
    worked at all.
25. **The redacted IR *is* a `SchemaModel`** — removals, blanking to constants and dense
    ordinal renumbering, with **real ids throughout** — so the canvas, the diff and the
    exporter run unchanged on it.
    Doc 05 owns the rules; this document owns the shape and owes a `validateModel`-clean
    result, asserted by the conformance suite.
26. **Realtime filtering is a visibility *transition*, not a filter**, plus an
    `access-changed` event for grant changes. Dropping a newly-invisible object from the
    frame leaves the old, unredacted copy in the recipient's memory for the whole session.
27. **Structural validation here, catalogue and syntax validation in the engine** — but
    identifier folding is injected into core via `normalizeName`, because the importer's
    insert-versus-update decision is core and exact matching silently duplicates tables.
28. **The engine validator never blocks a write; export and migration generation are gated on
    it.** You can save a half-typed type name; you cannot emit DDL from one.
29. **One index, memoized on a `WeakMap` keyed by the model object, with all its internal
    maps declared on the interface.** Immutable model replacement makes cache invalidation
    free, and a full rebuild at this scale is cheaper than incremental bookkeeping.

## Open questions

1. ~~**The three doc 02 columns (§8.1 D1/D2).**~~ **Closed.** Doc 02 adopted `fields.type_args`,
   `fields.type_dimensions` and `index_columns.is_include`. What remains from §8.1 is **D4**
   (`refs` on every `engine_props`-bearing table, required by doc 05 R27) and the tail of
   **D3** (drop `areas.collapsed`, which is per-viewer client state).
2. **Area geometry.** `Area.rect` is deleted; the canvas derives an Area's region from the
   bounding box of its members plus padding, because doc 02's `areas` table has no geometry
   columns and membership is explicit anyway. The cost: an Area with no members has no region
   and lives only in the sidebar legend until something is dropped into it. **If the product
   wants free-floating, hand-drawn Area rectangles that entities join by being dropped inside
   them, that is four columns on `areas` and a different decision — say so now.** Related:
   `areas.collapsed` and `areas.description` are not in the IR and can be dropped (D3).
3. ~~**Autosave versus per-object versions (C7) at canvas speed.**~~ **Closed, in doc 02's
   favour.** Geometry is outside the concurrency contract: `POST .../schema/geometry`
   (§8.11) neither reads nor bumps `version`, and `UpdateOp.patch` cannot name a geometry
   key. Doc 02 §10.4 had already decided this; the two documents now say the same thing.
4. **`isPii` and `isDeprecated` as core columns.** Made core for badge rendering and search
   filters, matching C4's treatment of `isRestricted`; `isPii` is now `governance` severity
   and `isDeprecated` is `documentation`. If product decides they are documentation rather
   than schema, they move into the docs module's structured facts and stop being diffable and
   filterable. Cheap to change now, painful once snapshots exist.
5. **Doc excerpt length.** `DOC_EXCERPT_CHARS = 200` is a judgement call that keeps a fully
   documented 300-entity project under ~2.3 MB. It has to be long enough for a useful search
   snippet and hover card. **Confirm 200, or name a number.** Related: `FieldDocFacts` is no
   longer in the IR, so anything that wants allowed-values or examples fetches the doc row —
   confirm that docs mode and the AI serializer are both happy to do that (both already run
   server-side or already open the docs panel).
6. **Client-generated ids** are required by the batch design but mean the server accepts a
   caller-chosen primary key. C1 says ids are cuids without saying who mints them. Assumed
   acceptable because the server rejects collisions and owns every
   tenancy column — **please confirm**, since the alternative (server-minted ids plus client
   temporary ids and an id map in the response) is significantly more code in the canvas
   store.
7. **`engineVersion` semantics.** Assumed to mean the *target database* version ("16"), not
   the engine plugin's package version, since migrations and type catalogues depend on the
   former. If the registry needs plugin versions too, that is a second field.
8. **Batch idempotency, if measurement disagrees with §8.7.** The design says a timed-out
   batch is resolved by refetching. If telemetry shows that happening often on flaky
   connections, the upgrade is a narrow `applied_batches(batch_id PK, project_id, applied_at,
   result_json)` table with a few-hour TTL, written in the same transaction, returning the
   stored result verbatim on a replay. It is deliberately **not** the op log decision 18
   rejects. **Not building it now; flagging the trigger.**
9. **Ordinal width in `sortPath`.** Four digits, because ordinals are dense `0…n-1`
   (decision 19). If gap ordinals (1000, 2000) are ever adopted to reduce reorder churn, the
   width must widen with them or lexicographic ordering breaks silently.
10. **Cross-namespace and cross-project entity renames** are not detected, because there is no
    heuristic at all now. Same-project diffs are saved by id matching, so this bites only
    imports and cross-project comparisons, where the user pins the pair by hand. The Phase 4
    diff/history document owns the candidate generator and the confirm UI, and will need to
    re-derive weights that can actually reach their threshold for entities.
11. **Possibly over-built, flagged per the brief.** `MatchStrategy` has one caller per value
    and could be inferred from whether both models share a `projectId`;
    `SnapshotRef.kind: 'import'` only ever becomes a label; and `irVersion` plus
    `upgradeModel` are pure future-proofing with an empty switch in v1. All three kept,
    because snapshots are permanent data and retrofitting a version tag onto blobs already in
    production is the classic version of this mistake.
12. ~~**Cross-document nit for doc 03.**~~ **Closed.** Doc 03 declares
    `annotateDiff(diff, before, after): AnnotatedDiff`; §7.7 above now names `AnnotatedDiff`
    as doc 03's type and explains why entry-level risk lives there rather than on
    `DiffEntryBase`.
13. **`isPii` and `isDeprecated` need `schema:edit`, not `docs:edit`.** They are core IR
    columns (§2.6), so they are written through a schema op and §8.5's table gates them at
    `schema:edit` — which means a **Documenter cannot flag a column as PII**, even though
    classifying fields is arguably their whole job. Doc 05 §2.2 originally listed both flags
    under `docs:edit`; that has been corrected to match this table rather than adding a
    second permission branch to the op path. **If product wants documenters to set them, the
    smallest fix is one more row in §8.5** (`update field`, patch ⊆ `{isPii, isDeprecated}`
    → `docs:edit`), not moving the columns. Related to doc 05's own Open question 5 about
    `isRestricted`.
