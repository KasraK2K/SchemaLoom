# 03 — `packages/engine-sdk`: EngineDefinition + Engine UI plugin contracts

Status: **design pass, for review.** No source files exist yet; every block below is the
contract that implementers will type out verbatim.

This is the seam. Everything else in SchemaLoom may know that a project has *entities* and
*fields*; only the packages under `packages/engines/*` may know that PostgreSQL calls them
tables and columns. If a single `if (engineId === 'postgresql')` survives in `apps/api` or
`apps/web`, this document has failed.

---

## 1. Package shape and boundaries

Per **C10**, `engine-sdk` depends on `@schemaloom/schema-model` and `zod`. Nothing else. It
must not import React, NestJS, Prisma, or any Node built-in, because the same module is
loaded in the browser.

```
packages/engine-sdk/
  package.json
  src/
    index.ts              # the "." entry: everything below, re-exported
    ir.ts                 # the ONLY file that names schema-model types (see 2.1)
    diagnostics.ts        # Diagnostic, SourceRange, QuickFix, renderDiagnostic
    errors.ts             # the three error classes the registry and gates throw (§14.1)
    capabilities.ts       # EngineFeature, EngineCapabilities, defineCapabilities
    type-catalog.ts       # TypeDescriptor, ResolvedType, createTypeCatalog
    props.ts              # EnginePropsSchemas, parseEngineProps
    links.ts              # checkLink — the declarative link-rule evaluator
    validator.ts
    importer.ts
    exporter.ts
    migration.ts
    query.ts
    ai.ts                 # AiProfile + the shared tagged-block stream parser
    definition.ts         # EngineStaticFacet, EngineDefinition
    registry.ts           # EngineRegistry, EngineDescriptor, AnnouncedEngine
    versioning.ts         # compareEngineVersion + the read-only verdicts (§15)
    terminology.ts        # Term, TerminologyBundle, formatMessage (strings, no React)
    ui/
      index.ts            # the "./ui" entry: React-typed plugin contracts + registry,
                          #   plus the isomorphic re-export surface doc 01 §6.1 fixes
    conformance/
      index.ts            # the "./conformance" entry: describeEngineConformance
```

```jsonc
// packages/engine-sdk/package.json (exports map only) — doc 01 §7.1 owns this file; the
// shape below is that file, restated so this document reads on its own.
{
  "name": "@schemaloom/engine-sdk",
  "type": "module",
  "exports": {
    ".":             { "types": "./dist/index.d.ts",       "import": "./dist/index.js",       "require": "./dist/index.cjs" },
    "./ui":          { "types": "./dist/ui.d.ts",          "import": "./dist/ui.js",          "require": "./dist/ui.cjs" },
    "./conformance": { "types": "./dist/conformance.d.ts", "import": "./dist/conformance.js", "require": "./dist/conformance.cjs" }
  },
  "dependencies": { "@schemaloom/schema-model": "workspace:*", "zod": "catalog:" },
  "peerDependencies": { "react": "catalog:", "@codemirror/state": "catalog:" },
  "peerDependenciesMeta": {
    "react":             { "optional": true },
    "@codemirror/state": { "optional": true }
  },
  "devDependencies": { "vitest": "catalog:", "esbuild": "catalog:" }
}
```

**Dual format, not ESM-only**, because `apps/api` compiles as CommonJS (decorators +
`emitDecoratorMetadata`) and resolves the `require` condition — doc 01 §9.1. The two peers
are optional and type-only at the `.` entry, so `apps/api` installs neither and still
resolves the package. **`vitest` and `esbuild` are plain devDependencies, not peers** (doc
01 §12): nothing here is published, every consumer is in this repo and already has vitest,
and `./conformance` is only ever imported from a `*.spec.ts` no runtime bundle includes — a
peer entry made the manifest advertise a plugin contract this package does not have.
`./ui` is the only entry that imports React types.

### 1.1 The client/server split inside an engine package

An engine package is one npm package with two entry points:

| entry | contains | loaded by |
| --- | --- | --- |
| `@schemaloom/engine-<id>` | the full `EngineDefinition` | `apps/api` only |
| `@schemaloom/engine-<id>/static` | only the `EngineStaticFacet` — pure data plus pure functions | `apps/web`, the engine's UI package |

This exists because the PostgreSQL importer pulls in `libpg-query` (a multi-megabyte WASM
build). The browser needs capabilities, the type catalog and terminology; it must never need
the parser. `EngineDefinition extends EngineStaticFacet`, so there is one object at runtime on
the server and no duplicated data.

The conformance suite enforces the split with a bundle-size check on the `/static` entry
(default budget 50 KB min+gzip).

---

## 2. Shared primitives

### 2.1 IR types — the single coupling point

```ts
// packages/engine-sdk/src/ir.ts
// The only file in engine-sdk that names a schema-model export. Names verified against
// docs/phase1/04-schema-model-ir.md.
export type {
  SchemaModel,      // the root IR object
  Id,
  Namespace, Entity, Field, Link, Index, IndexColumn, Constraint, CustomType, Area,
  IrObject, IrObjectType,   // 'area'|'namespace'|'customType'|'entity'|'field'|'constraint'|'index'|'link'
  IrBase,
  TypeRef,          // a field's type — structured, not a string (§5)
  LinkEndpoint,     // { entityId, fieldIds } — reused verbatim by checkLink (§7)
  Cardinality,      // '1:1' | '1:N' | 'N:1' | 'N:M'
  DocRef,           // { id, excerpt } — NOT { plainText, facts }; see §10.2
  RestrictionMark,  // { level: 'stub' | 'masked' | 'propsRedacted' }
  ObjectRefs,       // { entityIds, fieldIds } — the target of extractReferences (§3.1)
  SchemaDiff, DiffEntry, PropertyChange, PropertySeverity,
  IrPatch,
  // The single-path types. doc 05 §8.6 requires the brand, the hash-private payload and
  // `redact` to share one module, and C10 puts that module in schema-model — so this
  // package RE-EXPORTS them and declares none of them.
  RedactedModel, RawSchemaModel, VisibilityContext,
} from '@schemaloom/schema-model';

export {
  IR_OBJECT_TYPES, MAX_FIELD_DEPTH,
  destructiveEntries, isEmptyDiff, diffModels,
} from '@schemaloom/schema-model';

/** A pointer to any IR object. schema-model has no such type; it is tiny and appears in half
 *  the engine-sdk signatures, so it is defined here. */
export interface IrObjectRef {
  readonly type: IrObjectType;
  readonly id: Id; // cuid, identical to the database row id (C1)
}

/** Kind values are engine-defined OPEN sets. Doc 04 §3 types them `string` in core — the
 *  moment core writes `kind === 'table'` the engine boundary is gone — and says the
 *  narrowing helper belongs here. These five aliases exist so a descriptor field reads as
 *  what it is; they are `string`, and an engine narrows its own with a type guard
 *  (doc 04 §3's `PG_ENTITY_KINDS` / `isPgEntity` pattern). They are NOT imported from
 *  schema-model, which deliberately exports no such names. */
export type OpenKind<Known extends string = never> = Known | (string & {});
export type EntityKind     = OpenKind;
export type LinkKind       = OpenKind;
export type IndexKind      = OpenKind;
export type ConstraintKind = OpenKind;
export type CustomTypeKind = OpenKind;

/** "Downward" in "annotateDiff may refine severity downward, never upward" needs an order, or
 *  the conformance check cannot be written. This is it — TOTAL over doc 04's four
 *  severities, because a three-entry record does not satisfy
 *  `Record<PropertySeverity, number>` and `governance` is one of them.
 *
 *  `governance` outranks everything an engine may touch, and the second half of the rule
 *  covers it: **`annotateDiff` may neither assign nor remove `governance`.** Core alone
 *  decides that a change affects who can see an object (doc 04 §7.4), and `ignoreCosmetic`
 *  must never be able to drop it. The conformance check asserts both halves. */
export const PROPERTY_SEVERITY_RANK: Readonly<Record<PropertySeverity, number>> = {
  governance: 3,
  structural: 2,
  documentation: 1,
  cosmetic: 0,
};
```

Which signatures take `RedactedModel` is not a stylistic choice: **every engine surface whose
output reaches a user takes `RedactedModel`** — `exporter.export`, `queryValidator.validate`,
`aiProfile.serializeContext`, `defaultJoinPaths`. Everything that runs server-side over the
true model (`validate`, `annotateDiff`, `migrationGenerator.generate`, `importer.import`,
`extractReferences`) takes plain `SchemaModel`. `checkLink` takes `SchemaModel` because it runs
on both sides (§7.1 says what it does when it meets a redacted one).

Four things about the IR shape that materially changed this document, all taken from
doc 04 rather than assumed:

- **`Field.type` is a `TypeRef`, not a string, and it has NO `display`.** Doc 04 deleted the
  rendered label: it is derived, so a client minting it on every write while the server also
  computes it guarantees two renderers that drift (`varchar(255)` versus
  `character varying(255)`), with the stored value depending on who wrote the row last. The
  catalog still renders — `ResolvedType.display`, produced by `format()` — it just renders on
  demand instead of denormalising into the row (§5).
- **Documentation on the IR is `DocRef { id, excerpt }`**, a bounded ≤200-character excerpt
  of the flattened TipTap text, and it lives on `Area`, `Entity` and `Field` only — **not on
  `IrBase`**, because doc 02's `TargetType` covers only those three plus `project`. Generic
  code narrows with `'doc' in obj`. There is no `plainText` and no `facts` on the IR: the
  full text and the structured field facts are rows the docs endpoint serves (§10.2).
- **Redaction is marked on the IR** as `IrBase.restricted?: RestrictionMark` with three
  levels — `'stub' | 'masked' | 'propsRedacted'`. Engines skip `stub` and `masked` objects
  and emit `propsRedacted` ones without their `engineProps`, all without knowing what a
  permission is. Ids in a redacted model are **real** (doc 05 §7.10); there is no stub token.
- **`IrBase.refs?: ObjectRefs` is the output of `extractReferences` (§3.1)**, persisted and
  read by doc 05's R27. It is server-owned: an engine produces it, nothing else writes it.

### 2.2 Ids, ranges, context

```ts
// packages/engine-sdk/src/diagnostics.ts
export type EngineId = string; // lowercase slug: 'postgresql', 'mongodb', 'neo4j'

/** `Area` is the one IR object with no engineProps (doc 04 §2.11), so it is excluded.
 *  `'indexColumn'` is added because doc 02 gives `index_columns` its own `engine_props`
 *  column (per-column operator class, collation, NULLS order) and doc 04 §2.8 surfaces it
 *  as `IndexColumn.engineProps`. An `IndexColumn` is not an IR *object* — no id, no version
 *  — but it is the one nested structure carrying a props bag, and a bag with no schema
 *  owner is the untyped-JSONB hole §6 exists to close.
 *  There is deliberately no `'project'` member: no engine in phases 1–5 has a project-level
 *  prop, and there is nowhere to store one — `Project.settings` is core-owned and validated by
 *  core's `projectSettingsSchema` (doc 02 §7). Adding project-level engine props later means a
 *  real `engine_props Json` column on `Project`, not a third owner of `settings`. */
export type EnginePropsKind = Exclude<IrObjectType, 'area'> | 'indexColumn';

/** Offsets are UTF-16 code-unit offsets into the source string — exactly what CodeMirror 6
 *  wants for a decoration range. line/column are 1-based and derived; they are carried so the
 *  API can render an error message without shipping the source back. */
export interface SourceRange {
  readonly start: number;  // inclusive
  readonly end: number;    // exclusive
  readonly line: number;
  readonly column: number;
}

/** Everything an engine is allowed to know about the project it is working on. Deliberately
 *  tiny: no user, no permissions, no database handles. Redaction has already happened before
 *  any IR reaches an engine. */
export interface EngineContext {
  readonly projectId: Id;
  /** `Project.engineVersion` / `SchemaModel.engineVersion` — the TARGET DATABASE version,
   *  e.g. '16' for PostgreSQL 16. Not the plugin version (§15). The engine needs it to emit
   *  version-correct DDL; nothing in the SDK branches on it. */
  readonly serverVersion: string | null;
}
```

### 2.3 Diagnostics and quick fixes

One diagnostic type is used by the validator, the importer, the exporter, the migration
generator and `parseEngineProps`. The UI has one renderer for all of them.

**A diagnostic carries no prose.** This is the single most important thing about the type and
it is not a stylistic preference. The validator runs server-side over the **unredacted** model
(§8.3); its results are cached per project (§8.1) and broadcast to every socket in the project
room. A pre-rendered English sentence — `"orders.employee_id (uuid) is not compatible with
salaries.id (bigint)"` — cannot be filtered: `VisibilityFilter` can drop a diagnostic by
`target.id`, but it cannot redact a string, and a diagnostic targeting a link the analyst *can*
see would hand them the name and primary-key type of a table they cannot. So a diagnostic is
`code` + `params`, and the sentence is rendered per recipient, **after** redaction.

```ts
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface DiagnosticTarget {
  /** 'project' is for diagnostics with no IR object: an unparseable import statement, a
   *  whole-source failure. Its `id` is then the project id and `range` carries the location. */
  readonly type: IrObjectType | 'project';
  readonly id: Id;
  /** path inside engineProps, when the problem is one specific property */
  readonly propPath?: readonly string[];
}

/** A substitution value. An `IrObjectRef` is resolved to a name by CORE, per recipient, after
 *  redaction — a ref the subject cannot see renders as the core message `diag.restrictedObject`
 *  ("a restricted object"), which is how a name never crosses a permission boundary. */
export type DiagnosticParam = string | number | IrObjectRef;

export interface Diagnostic {
  /** '<engineId>.<kebab-slug>' — stable, greppable, and the key into the engine's message
   *  catalog (§2.4) */
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly params: Readonly<Record<string, DiagnosticParam>>;
  readonly target: DiagnosticTarget;
  /** present only when the diagnostic came from parsing text (import, query validation) */
  readonly range?: SourceRange;
  readonly quickFix?: QuickFix;
}

export interface QuickFix {
  /** message id in the engine's catalog, rendered the same way as `code` */
  readonly labelCode: string;             // 'postgresql.fix.rename-to'
  readonly labelParams: Readonly<Record<string, DiagnosticParam>>;
  /** The target object's `version` (C7) when the diagnostic was produced. Sent as
   *  `expectedVersion`; a fix the user clicks minutes later against a since-edited object
   *  409s cleanly instead of clobbering. Diagnostics are cached, so this is not optional. */
  readonly targetVersion: number;
  readonly edit: QuickFixEdit;
}

/** Deliberately narrow and serializable. A quick fix crosses the wire as JSON and is applied
 *  by the normal core object-update endpoint, which re-runs permissions, the version check
 *  (C7) and props validation. Engines cannot smuggle arbitrary mutations through a
 *  diagnostic. Note there is no `delete`: see below. */
export type QuickFixEdit =
  | { readonly op: 'setName'; readonly value: string }
  | { readonly op: 'setType'; readonly value: TypeRef }
  | { readonly op: 'setEngineProp'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unsetEngineProp'; readonly path: readonly string[] }
  /** routed to the object DELETE route, not the update route — it needs its own permission
   *  check, and per C8 a schema object is hard-deleted with no undo. Never valid for a
   *  `'project'` target: the type forbids it, because a representable "quick fix that deletes
   *  the project" is not a risk worth carrying. */
  | { readonly op: 'deleteObject'; readonly targetType: IrObjectType };
```

**How core applies a path-scoped op.** `setEngineProp` / `unsetEngineProp` name a path, but the
only write path in the design is `EnginePropsPipe`, which validates `engineProps` as a whole
object (§6.1). There is no path-scoped endpoint and there will not be one. Core applies a path
op by loading the object's current `engineProps`, deep-setting or deleting at `path` in memory,
and submitting the resulting **whole** object through the same endpoint with
`expectedVersion: quickFix.targetVersion`. Permissions, C7 and `.strict()` validation all still
run, and the engine never gets a private mutation channel.

### 2.4 Rendering a diagnostic

Engines own their wording; core owns when and to whom it is shown.

```ts
/** Diagnostic-code → template, on the static facet so the browser renders without a round
 *  trip. Same placeholder syntax as the core message catalog (§16.2): `{name}` slots filled
 *  from `params`. One sentence, no trailing period. */
export type DiagnosticMessages = Readonly<Record<string, string>>;

// e.g. in the PostgreSQL engine:
// 'postgresql.link-type-mismatch': '{source} ({sourceType}) is not compatible with {target}
//                                   ({targetType})',
// 'postgresql.fix.rename-to':      'Rename to {name}',

/** Core's only renderer. `resolveRef` is supplied by core and is the redaction boundary: it
 *  returns a display name for a ref the subject may see, and `null` for one it may not — which
 *  renders as the core term for a restricted object. An unknown `code` renders as the code
 *  itself, so a missing template is visible but never a crash. */
export function renderDiagnostic(
  messages: DiagnosticMessages,
  bundle: TerminologyBundle,
  diagnostic: Diagnostic | QuickFix,
  resolveRef: (ref: IrObjectRef) => string | null,
): string;
```

The consequences are worth stating, because they are what the structured form buys:

- The Redis cache (§8.1) holds structured diagnostics, which are **subject-independent** and
  therefore legitimately cacheable per project. Only the rendered strings are per subject, and
  they are computed on the way out, never stored.
- `VisibilityFilter` drops diagnostics whose `target` the subject cannot see, and *also* rewrites
  the `params` of the survivors. Both are mechanical over a typed structure.
- Translation later has one catalog per engine plus the core catalog, and no string surgery.

### 2.5 Diagnostic ordering contract

Any function returning `readonly Diagnostic[]` returns them sorted by, in order: `diagnosticTypeRank(target.type)`, `target.id`, `code`,
`(target.propPath ?? []).join('.')`, `range?.start ?? -1`. Byte comparison (`<`), never
`localeCompare`, whose result depends on the server's ICU data. This is what makes "the
validator is deterministic" a testable statement and what keeps cached diagnostic payloads
diff-stable.

```ts
/** schema-model's IR_OBJECT_TYPES is the dependency order and the single source of rank;
 *  'project' sorts before all of it. No second ordering table. */
export function diagnosticTypeRank(type: DiagnosticTarget['type']): number;

export function sortDiagnostics(input: readonly Diagnostic[]): readonly Diagnostic[];
```

---

## 3. `EngineDefinition`

```ts
// packages/engine-sdk/src/definition.ts
export type EngineParadigm =
  | 'relational' | 'document' | 'key-value' | 'wide-column' | 'graph';

/** The half of an engine that is safe and cheap to load in a browser: pure data plus pure
 *  functions over that data. No parsers, no Node built-ins, no I/O. */
export interface EngineStaticFacet {
  readonly id: EngineId;
  readonly displayName: string;   // 'PostgreSQL'
  readonly version: string;       // semver of the engine's behaviour contract (see §15)
  readonly paradigm: EngineParadigm;
  readonly icon: string;          // lucide icon name, e.g. 'database'
  readonly summary: string;       // one line for the engine picker card
  readonly capabilities: EngineCapabilities;
  readonly typeCatalog: TypeCatalog;
  readonly terminology: TerminologyBundle;
  readonly diagnosticMessages: DiagnosticMessages;   // §2.4
  /** zod only, no parser — so it loads in the browser, which is where react-hook-form needs
   *  it. Doc 01 places it on the engine's `/static` entry twice; this is that placement. */
  readonly propsSchemas: EnginePropsSchemas;
  /** Fold a name to the spelling the engine treats as the same object — the one
   *  engine-supplied function core needs for identity (doc 04 §6.3 / Key decision 16). Pure,
   *  total, no I/O. It sits on the facet rather than on the server-only `EngineDefinition`
   *  because the canvas's name-collision check runs client-side, in the keystroke that types
   *  the name; core's import matcher and the exporter call the same function server-side.
   *  Without it `Orders` is inserted next to `orders` and the export emits DDL PostgreSQL
   *  rejects. */
  normalizeName(s: string): string;
}

export interface EngineDefinition extends EngineStaticFacet {
  readonly validator: EngineValidator;
  readonly importer: Importer;
  readonly exporter: Exporter;
  /** Adds risk semantics to a core-produced diff (doc 04 §7.7). Core pre-sets only
   *  "a removed namespace/entity/field/customType is destructive"; everything else —
   *  varchar(255) -> varchar(64), NOT NULL added, an enum label dropped — is engine
   *  knowledge. Pure and synchronous. Returns the branded AnnotatedDiff (§11.1), which is
   *  the only thing the migration generator accepts. */
  annotateDiff(diff: SchemaDiff, before: SchemaModel, after: SchemaModel): AnnotatedDiff;
  /** The three phase-gated services are OPTIONAL, and their presence must agree with the
   *  capability atoms — `capabilities/services-match-features` (§4.1) asserts
   *  `features.migrations === (migrationGenerator !== undefined)` and
   *  `features.queryValidation === (queryValidator !== undefined)`. That is what stops an
   *  engine advertising a feature it has not implemented, and it is what lets doc 01 §13
   *  ship the Phase 1 PostgreSQL engine with no `migration/`, `query-validator/` or
   *  `ai-profile/` directory and fill them in at Phases 4 / 2 / 2 with no interface change.
   *  The alternative — required from day one with throwing stubs — makes the conformance
   *  suite lie about what an engine supports. */
  readonly migrationGenerator?: MigrationGenerator;
  readonly queryValidator?: QueryValidator;
  /** No feature atom: nothing else in core branches on AI, so `aiProfile === undefined`
   *  simply hides the AI panel and makes the AI routes 400 `engine.feature-unsupported`. */
  readonly aiProfile?: AiProfile;
  /** The engine's only obligation to the permission system (§3.1). Pure. REQUIRED — it
   *  fails closed, so a new engine gets the conservative behaviour for free. */
  extractReferences(object: IrObject, subKind: string | null, model: SchemaModel): readonly IrObjectRef[];
}
```

What is deliberately *not* on the definition:

- **No `linkRules` function.** Link legality is declarative data in `capabilities.linkKinds`,
  evaluated by one shared function (§7). The canvas needs a synchronous answer mid-drag and the
  server needs the same answer on write; a single data-driven evaluator is the only way those
  two cannot drift.
- **No `queryLanguage` on `aiProfile`.** It lives at `capabilities.queryLanguage` — one source
  of truth, read by the AI profile, the CodeMirror mode, the export dialog and the saved-query
  library. (The brief lists it under `aiProfile`; duplicating it is how they diverge.)
- **No lifecycle hooks, no `init()`.** A definition is a frozen object literal. An engine that
  needs lazy WASM initialisation does it inside `importer.import()` behind a module-level
  promise.
- **No `introspector`.** The spec files live-database introspection under "Future", it has no
  consumer in phases 1–5, and designing it now drags live credential handling into a pass whose
  output is a set of interfaces. Restoring it is purely additive — one optional member plus one
  `IntrospectionTarget` — and the conformance suite makes that safe. Cut.
- **No `propsMigrations`.** See §15: a major bump opens read-only until someone writes the
  migration, and that is one paragraph instead of a subsystem.

### 3.1 `extractReferences` — the one method the permission system requires

Doc 05 §8.4 rows L3–L6 are the leaks that close the design: a CHECK body, a partial-index
predicate, a default expression and a generated-column expression are all **engine syntax living
in `engineProps`**, which C4 forbids core from reading. A Restricted `salary` column named inside
`CHECK (discount < employees.salary * 0.1)` therefore reaches a Viewer verbatim, in the inspector
and in an export, and nothing in the pipeline can tell that the expression touches a hidden field.
Doc 05 names doc 03 as the owner of the contract that makes this detectable. This is it.

```ts
/** Given one IR object, return every IR object its engine-owned expressions reference. Ids
 *  only — never names, never the expression text. Pure, synchronous, total: an expression the
 *  engine cannot parse yields the ids it did recognise, and the engine emits a validator
 *  warning (§8.2) so the gap is visible rather than silent.
 *
 *  Called by core on EVERY write of an expression-bearing object and on import, and the
 *  result persisted to ONE real column per object — doc 02 dependency: `refs Json` on every
 *  table that carries `engine_props` (doc 04 §8.1 delta D4), surfacing on the IR as
 *  `IrBase.refs?: ObjectRefs`. This replaces the three parallel `*_referenced_ids`
 *  arrays an earlier draft asked for, which doc 02 Key decision 23 rejected (doc 05 Key
 *  decision 12 having chosen the same single column independently) because they still missed
 *  `CREATE INDEX ON employees ((salary * 12))` — an expression naming no field id at all.
 *  Core maps the returned `IrObjectRef[]` onto `{ entityIds, fieldIds }`; refs to other
 *  object types are recorded but unused by R27 today. */
extractReferences(object: IrObject, subKind: string | null, model: SchemaModel): readonly IrObjectRef[];
```

Three rules make it a security control rather than a hint:

1. **Superset, not exact set.** Returning an id the expression does not really touch costs a
   dropped expression for one viewer. Missing one is a leak. The conformance check
   `references/superset` asserts that for every expression-bearing object in the reference
   model, every id whose object name appears as a token in the expression is present in the
   result.
2. **Fail closed.** `extractReferences` is a **required** member. An engine that cannot analyse
   its own expressions returns `[]` *and* declares it, by returning `[]` for every object —
   at which point `VisibilityFilter` drops every expression-bearing prop for any subject lacking
   `field:viewRestricted` over the whole entity. That is the conservative default, and it is
   what a new engine gets for free on day one.
3. **It is also the staleness detector.** JSONB has no foreign keys, so renaming `orders.status`
   leaves `CHECK (status IN ('paid','pending'))` pointing at a name that no longer exists, the
   visual diff shows a clean rename, and the export emits DDL PostgreSQL rejects. With reference
   ids persisted, core can see that a rename or delete touched a referenced id and the validator
   raises a dangling-reference diagnostic (§8.2). Conformance fixture:
   `validator/expression-reference-stale`.

---

## 4. `EngineCapabilities`

Two rules drive this design:

1. **Capabilities are pure JSON.** They are served to the browser by `GET /engines` and cached
   in the project store. No functions, no classes. That is what lets the fallback UI (§16.4)
   gate features correctly for an engine that ships no UI package at all.
2. **Boolean feature atoms are a total record, defaulting to `false`.** Core writes
   `caps.features.indexes` and never `caps.features.indexes === true` on a `boolean | undefined`.
   When a new feature atom is added to the SDK, every existing engine gets `false` — a new core
   feature never silently switches itself on for an engine that was never tested with it.
3. **An atom exists only when nothing else in `EngineCapabilities` already answers the
   question.** The first draft of this list had 33 atoms, of which fourteen restated a fact that
   also lived on a descriptor — `enforcedLinks` beside `LinkKindDescriptor.enforced`,
   `checkConstraints` beside a `ConstraintKindDescriptor` whose id is `'check'`, `views` beside
   an `EntityKindDescriptor` whose id is `'view'`. Duplicated truth in a capability record is
   how an engine ends up self-contradicting itself: MongoDB declares `enforcedLinks: false` and
   copy-pastes `enforced: true` onto its one link kind, `CapabilityGate` hides the ON DELETE UI,
   and `checkLink` and the exporter — which read the descriptor — happily emit referential
   actions. Those atoms are deleted, and where core wants a boolean it calls a derived helper.

```ts
// packages/engine-sdk/src/capabilities.ts
export const ENGINE_FEATURES = [
  // fields
  'nestedFields', 'notNull',
  // links
  'links', 'referentialActions',
  // indexes
  'indexes', 'expressionIndexes', 'includeColumns',
  // engine services
  'comments', 'migrations', 'queryValidation',
] as const;

export type EngineFeature = (typeof ENGINE_FEATURES)[number];
```

Every atom, and the core surface that reads it. **An atom with no row here does not exist.**

| atom | the core surface that branches on it |
| --- | --- |
| `nestedFields` | the field tree in the inspector: the indent affordance and the "Add nested field" action. Paired with `maxFieldDepth` |
| `notNull` | the Nullable checkbox in the core field panel (`Field.isNullable` is a core column, doc 04 §2.6) and the `nn` flag in SCS |
| `links` | connection handles on canvas nodes (§16.1), the link inspector, and step 1 of `checkLink` |
| `referentialActions` | the ON DELETE / ON UPDATE selects in the link inspector. Invariant: implies some link kind is `enforced` |
| `indexes` | the Indexes tab, the sidebar section, the palette entry, the export checkbox, `POST /projects/:id/indexes`. The §16.5 worked example |
| `expressionIndexes` | the "expression" option in the core index-column editor (`IndexColumn.expression`, doc 04 §2.8) |
| `includeColumns` | the `role: 'include'` option in the same editor |
| `comments` | the "Include documentation as comments" checkbox in the export dialog, and §10.2 |
| `migrations` | the "Generate migration script" button in the snapshot-diff view |
| `queryValidation` | whether the AI panel underlines identifiers and blocks "Copy" on unknown ones |

And the derived helpers that replaced the deleted atoms. Each is a one-liner in
`capabilities.ts`, exported so core reads the answer from exactly one place:

```ts
export const supportsNamespaces   = (c: EngineCapabilities) => c.namespaces !== 'none';
export const anyLinkKindEnforced  = (c: EngineCapabilities) => c.linkKinds.some(k => k.enforced);
export const anyCompositeEndpoint = (c: EngineCapabilities) => c.linkKinds.some(k => k.compositeEndpoints);
export const anyLinkKindHasFields = (c: EngineCapabilities) => c.linkKinds.some(k => k.hasFields);
export const anyIndexTypeUnique   = (c: EngineCapabilities) => c.indexTypes.some(i => i.supportsUnique);
export const anyTypeSupportsArray = (c: EngineCapabilities) => c.typeCatalogSupportsArrays;
export const hasEntityKind        = (c: EngineCapabilities, id: string) => c.entityKinds.some(k => k.id === id);
export const hasConstraintKind    = (c: EngineCapabilities, id: string) => c.constraintKinds.some(k => k.id === id);
export const hasCustomTypeKind    = (c: EngineCapabilities, id: string) => c.customTypeKinds.some(k => k.id === id);
export const anySchemalessEntity  = (c: EngineCapabilities) => c.entityKinds.some(k => !k.fieldsAreAuthoritative);
export const canImport            = (c: EngineCapabilities) => c.importFormats.length > 0;
export const canExport            = (c: EngineCapabilities) => c.exportFormats.length > 0;
```

(`anyTypeSupportsArray` reads a precomputed boolean rather than scanning descriptors, because
the type catalog can be large and the answer never changes; `defineCapabilities` fills it.)

`links` and `indexes` survive as atoms even though `linkKinds.length > 0` and
`indexTypes.length > 0` answer the same question, because they are the two gates core reads in a
dozen places and `<CapabilityGate feature="indexes">` is the pattern the whole product copies.
The duplication is made safe rather than tolerated: `defineCapabilities` asserts each is exactly
`kinds.length > 0` (§4.1), so it is machine-checked, not a second source of truth.

```ts
export type NamespaceSupport = 'none' | 'optional' | 'required';

/** Kind ids are camelCase across every descriptor, matching doc 04's
 *  PG_ENTITY_KINDS = ['table', 'view', 'materializedView']. */
export interface EntityKindDescriptor {
  /** an EntityKind value: 'table' | 'view' | 'materializedView' | 'collection' | 'nodeLabel' */
  readonly id: EntityKind;
  /** One or two UPPERCASE letters, unique across entityKinds. The AI context format (§13.1)
   *  prefixes every entity line with it — `T` table, `V` view, `MV` materialized view,
   *  `C` collection, `L` node label. It is here and not derived from the id because two kinds
   *  starting with the same letter would silently collide in a format the model parses. */
  readonly shortCode: string;
  readonly icon: string;                  // lucide icon name
  /** false for a Redis key pattern: the card renders a description, not a field list */
  readonly hasFields: boolean;
  /** false for schemaless stores: fields are an observed sample, shown as "inferred" and
   *  never exported as a hard contract */
  readonly fieldsAreAuthoritative: boolean;
  readonly supportsIndexes: boolean;
  readonly supportsConstraints: boolean;
  readonly canBeLinkEndpoint: boolean;
}

export interface LinkKindDescriptor {
  readonly id: LinkKind;                  // 'foreignKey' | 'reference' | 'embeds' | 'edge'
  /** false renders an undirected line (Neo4j undirected match, a logical association) */
  readonly directed: boolean;
  /** true = the database enforces it. false = documentation-only (MongoDB reference); core
   *  then hides ON DELETE / ON UPDATE and labels the link "logical" on the canvas. */
  readonly enforced: boolean;
  /** 'field' = endpoints are fields (FK). 'entity' = endpoints are whole entities (graph
   *  edge, embedded document). Drives what the drag handle attaches to. */
  readonly endpointLevel: 'entity' | 'field';
  readonly compositeEndpoints: boolean;   // multi-field endpoints (composite FK)
  /** true = the link itself owns fields (Neo4j relationship properties). Core then shows a
   *  field list inside the link inspector; false hides that whole section. */
  readonly hasFields: boolean;
  readonly cardinalities: readonly Cardinality[];
  readonly defaultCardinality: Cardinality;
  readonly requireSameNamespace: boolean;
  readonly requireTypeCompatibility: boolean;
  readonly allowSelfReference: boolean;
  /** '*' = any entity kind */
  readonly allowedSourceEntityKinds: readonly string[] | '*';
  readonly allowedTargetEntityKinds: readonly string[] | '*';
}

export interface IndexTypeDescriptor {
  readonly id: IndexKind;                 // 'btree' | 'hash' | 'gin' | 'gist' | 'brin'
  readonly displayName: string;
  readonly isDefault: boolean;
  readonly supportsUnique: boolean;
  readonly supportsMultipleColumns: boolean;
  readonly supportsOrdering: boolean;     // per-column ASC/DESC/NULLS FIRST
  readonly summary: string;               // one line in the index-type picker
}

export interface ConstraintKindDescriptor {
  readonly id: ConstraintKind;            // 'primaryKey' | 'unique' | 'check' | 'exclusion'
  readonly scope: 'field' | 'entity';
  readonly maxPerEntity: number | null;   // 1 for primaryKey, null for unlimited
  /** true = the constraint body is an engine expression in engineProps, so it needs the
   *  engine's `panels.constraint` editor and participates in `extractReferences` (§3.1) */
  readonly hasExpression: boolean;
}

export interface CustomTypeKindDescriptor {
  readonly id: CustomTypeKind;            // 'enum' | 'domain' | 'composite'
  /** true = instances appear in the field type picker as a group (§5.4) */
  readonly usableAsFieldType: boolean;
}

export interface QueryLanguageDescriptor {
  readonly id: 'sql' | 'mongo-aggregation' | 'cypher' | 'cql' | 'redis' | (string & {});
  readonly displayName: string;           // 'SQL', 'Aggregation Pipeline', 'Cypher'
  readonly fileExtension: string;         // 'sql', 'js', 'cypher'
  /** id the UI plugin resolves to a CodeMirror LanguageSupport; core falls back to plain text */
  readonly codeMirrorMode: string;
  readonly lineComment: string;           // '--', '//'
  readonly statementSeparator: string | null; // ';' or null when statements are not separable
}

export interface IdentifierRules {
  readonly maxLength: number;
  readonly caseSensitive: boolean;
  readonly foldsTo: 'lower' | 'upper' | 'none'; // unquoted identifier folding
  readonly quoteOpen: string;
  readonly quoteClose: string;
  readonly validUnquoted: string;         // serialisable regex source, for client-side hints
  readonly reservedWords: readonly string[];
}

export interface ImportFormatDescriptor {
  readonly id: string;                    // 'ddl' | 'json-schema' | 'mongoose'
  readonly displayName: string;           // 'PostgreSQL DDL (.sql)'
  /** the file picker's `accept` list. No `mimeTypes`: browsers report '' or
   *  'application/octet-stream' for .sql, so a MIME list is a second source of truth that is
   *  wrong exactly when it matters. */
  readonly fileExtensions: readonly string[];
  readonly maxBytes: number;
}

export interface ExportFormatDescriptor {
  readonly id: string;                    // 'ddl' | 'mongo-shell'
  readonly displayName: string;
  readonly fileExtension: string;
  readonly supportsComments: boolean;
  readonly supportsDrops: boolean;
}

export interface EngineCapabilities {
  readonly features: Readonly<Record<EngineFeature, boolean>>;
  readonly namespaces: NamespaceSupport;
  /** the name pre-filled for the implicit namespace ('public'); null when namespaces:'none' */
  readonly defaultNamespaceName: string | null;
  readonly entityKinds: readonly EntityKindDescriptor[];
  readonly linkKinds: readonly LinkKindDescriptor[];
  readonly indexTypes: readonly IndexTypeDescriptor[];
  readonly constraintKinds: readonly ConstraintKindDescriptor[];
  readonly customTypeKinds: readonly CustomTypeKindDescriptor[];
  /** 1 = flat fields only; >1 = document nesting depth cap for the field tree UI */
  readonly maxFieldDepth: number;
  /** derived by defineCapabilities from the type catalog, so the array checkbox in the type
   *  picker is one boolean read rather than a scan over hundreds of descriptors */
  readonly typeCatalogSupportsArrays: boolean;
  readonly identifiers: IdentifierRules;
  readonly queryLanguage: QueryLanguageDescriptor;
  readonly importFormats: readonly ImportFormatDescriptor[];
  readonly exportFormats: readonly ExportFormatDescriptor[];
}
```

### 4.1 Construction and validation helpers

```ts
export interface CapabilitiesInput
  extends Omit<EngineCapabilities, 'features' | 'typeCatalogSupportsArrays'> {
  /** unlisted atoms default to false */
  readonly features: Partial<Record<EngineFeature, boolean>>;
  /** read once to fill typeCatalogSupportsArrays */
  readonly typeDescriptors: readonly TypeDescriptor[];
}

/** Fills the feature record and the derived flags, freezes the result, and throws
 *  `CapabilitiesContradictionError` (an `Error` subclass carrying `engineId` and the failed
 *  rule id) on any violation of the list below. */
export function defineCapabilities(input: CapabilitiesInput): EngineCapabilities;

/** zod schema for the wire form. apps/web validates GET /engines output with it, so a bad
 *  deploy produces a clear error instead of an undefined-flag UI. */
export const engineCapabilitiesSchema: z.ZodType<EngineCapabilities>;

/** Throws EngineFeatureUnsupportedError (§14.1); used by API controllers before a write. */
export function assertFeature(engine: EngineStaticFacet, f: EngineFeature): void;
```

There is deliberately no `hasFeature(caps, f)` helper: `features` is a total record, so
`caps.features.indexes` is the read, and a wrapper around a property access is ceremony.

**The invariants `defineCapabilities` enforces, in full.** This list is the contract; the
conformance check `capabilities/internally-consistent` re-runs it against the shipped object so
a hand-built capabilities literal cannot bypass the constructor.

| id | rule |
| --- | --- |
| `links-imply-kinds` | `features.links === (linkKinds.length > 0)` |
| `indexes-imply-types` | `features.indexes === (indexTypes.length > 0)` |
| `one-default-index` | when `indexTypes` is non-empty, exactly one has `isDefault: true` |
| `entity-kinds-present` | `entityKinds` is non-empty, ids are unique, `shortCode`s are unique and match `/^[A-Z]{1,2}$/` |
| `unique-kind-ids` | ids are unique within `linkKinds`, `indexTypes`, `constraintKinds`, `customTypeKinds` |
| `default-cardinality-allowed` | every `linkKinds[].cardinalities` contains its own `defaultCardinality` and is non-empty |
| `referential-actions-need-enforcement` | `features.referentialActions` implies `anyLinkKindEnforced(caps)` |
| `link-endpoint-kinds-exist` | every id in `allowedSource/TargetEntityKinds` (when not `'*'`) names an `entityKinds[].id` with `canBeLinkEndpoint: true` |
| `namespaces-none` | `namespaces === 'none'` implies `defaultNamespaceName === null` |
| `namespaces-some` | `namespaces !== 'none'` implies `defaultNamespaceName !== null` and non-empty |
| `depth-sane` | `maxFieldDepth >= 1`, and `maxFieldDepth > 1` implies `features.nestedFields` |
| `index-features-need-indexes` | `expressionIndexes`, `includeColumns` each imply `features.indexes` |
| `format-ids-unique` | `importFormats` and `exportFormats` have unique ids; `maxBytes > 0` |
| `query-language-present` | `queryLanguage.id` and `codeMirrorMode` are non-empty |
| `identifiers-sane` | `identifiers.maxLength >= 1`; `validUnquoted` compiles as a regex |
| `services-match-features` | `features.migrations === (engine.migrationGenerator !== undefined)` and `features.queryValidation === (engine.queryValidator !== undefined)`. Checked by the conformance suite rather than by `defineCapabilities`, which sees the capabilities object and not the definition. |

### 4.2 What the non-relational engines forced into the shape

| need | how it is expressed |
| --- | --- |
| MongoDB: databases are optional, not a first-class design object | `namespaces: 'optional'`; `supportsNamespaces(caps)` gates the whole namespace sidebar section |
| Redis / DynamoDB: no namespaces at all | `namespaces: 'none'`, `defaultNamespaceName: null`; the IR still has exactly one implicit namespace so core code never special-cases "no parent" |
| MongoDB: nested document fields | `features.nestedFields`, `maxFieldDepth: 8`, IR `Field.parentFieldId` |
| MongoDB / DynamoDB: schemaless collections | `EntityKindDescriptor.fieldsAreAuthoritative: false`; the entity card shows an "inferred" badge and export emits no hard field contract |
| No foreign keys anywhere | `features.links: false`, `linkKinds: []`; the canvas hides connection handles entirely and the link inspector never mounts |
| Logical references that the DB does not enforce | `LinkKindDescriptor.enforced: false` → `features.referentialActions` is then illegal, so core hides ON DELETE/ON UPDATE without knowing why |
| Neo4j: relationships carry properties | `LinkKindDescriptor.hasFields: true` → link inspector grows a field list, reusing the field panel |
| Neo4j: direction matters, and both ends are whole nodes | `directed: true`, `endpointLevel: 'entity'` |
| Cassandra: no arbitrary secondary indexes | `features.indexes: false` → §16.5 worked example |
| Engines with no DDL comments | `features.comments: false` → export dialog hides "Include documentation comments" |
| Views, materialized views, collections, node labels | `entityKinds` rows; `hasEntityKind(caps, 'view')` is the gate, never a feature atom |
| CHECK / exclusion constraints an engine lacks | absent from `constraintKinds`; `hasConstraintKind(caps, 'check')` is the gate |
| Enums / domains / composites an engine lacks | absent from `customTypeKinds`; `hasCustomTypeKind(caps, 'enum')` is the gate |

---

## 5. `TypeCatalog`

A field's type is a **`TypeRef`** (doc 04 §2.6): `{ name, args?, customTypeId?, dimensions? }`.
Core owns that structure because search, the diff and the migration generator all need "did
the type change?" to be answerable structurally. The catalog is what gives `name` and `args`
meaning: it resolves `customTypeId`, renders the label, and tells the UI which parameters
exist.

**There is no `TypeRef.display`.** Doc 04 deleted it, and this document follows: a rendered
label is derived, so storing it means the client mints one on every create and update while
the server computes its own, and the two drift on the first edge case. Rendering is done on
demand by `typeCatalog.format(typeCatalog.resolve(ref, ctx))`, whose result is
`ResolvedType.display`; the canvas gets it from the engine's `TypeBadge` (spec §3.3 puts type
badges in the engine UI plugin), and the exporter and AI serialiser render their own. One
renderer, one place, nothing denormalised.

```ts
// packages/engine-sdk/src/type-catalog.ts
export type TypeCategory =
  | 'numeric' | 'string' | 'boolean' | 'temporal' | 'binary' | 'json' | 'uuid'
  | 'geometric' | 'network' | 'range' | 'user-defined' | 'other';

/** Parameters are not all numbers. `geometry(Point, 4326)`, `interval day to second(3)` and a
 *  Cassandra collection element type all take a non-numeric first argument, and doc 04 types
 *  `TypeRef.args` as `(string | number)[]` for exactly that reason. A numbers-only descriptor
 *  would drop the first argument on resolution, so `format(resolve(ref, ctx))` would no
 *  longer round-trip the stored ref. */
export type TypeParameterDescriptor =
  | {
      readonly kind: 'number';
      readonly name: 'length' | 'precision' | 'scale' | (string & {});
      readonly label: string;           // 'Length'
      readonly required: boolean;
      readonly min: number;
      readonly max: number;
      readonly default: number | null;  // pre-filled in the picker; null = leave blank
    }
  | {
      readonly kind: 'string';
      readonly name: string;
      readonly label: string;
      readonly required: boolean;
      readonly default: string | null;
    }
  | {
      readonly kind: 'enum';
      readonly name: string;
      readonly label: string;
      readonly required: boolean;
      readonly options: readonly string[];   // 'Point' | 'LineString' | 'Polygon'
      readonly default: string | null;
    };

export interface TypeDescriptor {
  /** canonical lowercase id, and the exact spelling the exporter emits: 'varchar', 'numeric' */
  readonly id: string;
  readonly displayName: string;       // 'varchar(n)'
  readonly category: TypeCategory;
  /** alternate spellings accepted on input: ['character varying'] */
  readonly aliases: readonly string[];
  /** empty = the type takes no parameters */
  readonly parameters: readonly TypeParameterDescriptor[];
  readonly supportsArray: boolean;
  /** pre-selected when the user picks this category in the type picker */
  readonly preferredForCategory: boolean;
  readonly deprecated: boolean;
  readonly summary: string;           // one line of help text in the picker
}
```

There is no `since: string | null`. Version-gated type availability is one of four knobs
(`TypeDescriptor.since`, `ExportFormatDescriptor.targetVersions`, `ExportOptions.targetVersion`,
`MigrationOptions.targetVersion`) that existed to target more than one server version of one
engine, in a v1 whose picker offers exactly one. All four are cut. `EngineContext.serverVersion`
stays — the engine genuinely needs it to emit version-correct DDL — and re-adding the knobs when
a second target version ships is additive.

### 5.1 Resolution

```ts
export interface TypeResolutionContext {
  /** project-scoped user-defined types (enum / domain / composite) */
  readonly customTypes: readonly CustomType[];
  /** namespace of the field being resolved, for unqualified user-type lookup */
  readonly namespaceName: string | null;
}

export type TypeResolutionStatus = 'builtin' | 'user-defined' | 'unknown';

export interface ResolvedType {
  /** exactly the TypeRef stored on the field */
  readonly ref: TypeRef;
  /** normalised spelling — what the exporter writes and what the badge shows. Rendered on
   *  demand by `format()`; it is NOT stored on the TypeRef (doc 04 deleted `display`). */
  readonly display: string;
  readonly status: TypeResolutionStatus;
  /** set when status === 'builtin' */
  readonly descriptor: TypeDescriptor | null;
  /** the resolved CustomType when status === 'user-defined'; null otherwise. Cross-checked
   *  against ref.customTypeId — a mismatch is a dangling-reference diagnostic. */
  readonly customType: CustomType | null;
  /** positional TypeRef.args mapped onto the descriptor's parameters:
   *  numeric(10,2) -> { precision: 10, scale: 2 }, geometry(Point,4326) ->
   *  { subtype: 'Point', srid: 4326 }. Empty for parameterless types. */
  readonly args: Readonly<Record<string, string | number>>;
  /** ref.dimensions ?? 0 */
  readonly dimensions: number;
  readonly category: TypeCategory;
}

/** The resolution function the brief asks for: given a stored field type, what is it. Total —
 *  never throws. An unrecognised name comes back as status 'unknown' with `display` echoing
 *  `ref.name` plus its arguments, and `args` untouched, so an imported exotic type survives a
 *  round trip verbatim. */
export type ResolveType = (ref: TypeRef, ctx: TypeResolutionContext) => ResolvedType;

export interface BuildTypeRefInput {
  readonly name: string;
  readonly args?: readonly (string | number)[];
  readonly dimensions?: number;
}

export interface TypeCatalog {
  readonly descriptors: readonly TypeDescriptor[];
  readonly resolve: ResolveType;
  /** Produces the complete TypeRef, including the resolved `customTypeId` and the
   *  normalised `name` / `args` / `dimensions`. The importer, the type picker and any quick
   *  fix build TypeRefs ONLY through this, so a stored ref is always in canonical form and
   *  `resolve` never has to guess. */
  buildRef(input: BuildTypeRefInput, ctx: TypeResolutionContext): TypeRef;
  /** the rendered spelling. `format(resolve(buildRef(x, ctx), ctx))` is stable under
   *  repetition — that idempotence is what `types/resolve-format-roundtrip` asserts. */
  format(resolved: ResolvedType): string;
  /** link endpoint compatibility, e.g. int4 ↔ int4, int4 ↔ serial, uuid ↔ uuid */
  areCompatible(a: ResolvedType, b: ResolvedType): boolean;
  /** the flat, grouped option list the type picker renders (§5.4) */
  listPickerOptions(ctx: TypeResolutionContext): readonly TypePickerOption[];
}
```

### 5.2 One implementation, not one per engine

```ts
export interface TypeCatalogOptions {
  readonly descriptors: readonly TypeDescriptor[];
  /** array syntax the engine uses. Two cases, because those are the two that exist across
   *  every engine in COMING_SOON; a third is added when an engine needs it. */
  readonly arraySyntax: 'suffix-brackets' | 'none';
  /** pairs of canonical ids treated as link-compatible beyond exact equality */
  readonly compatibilityGroups: readonly (readonly string[])[];
  /** e.g. serial -> int4 before anything else looks at it */
  readonly normalizeAliases?: Readonly<Record<string, string>>;
}

/** The generic catalog: parses `name`, `name(a)`, `name(a,b)`, `schema.name`, plus the array
 *  syntax, matches against descriptors and aliases case-insensitively, then falls back to the
 *  customTypes list, then to 'unknown'. Every v1 engine uses this; an engine only writes its
 *  own TypeCatalog if its type grammar genuinely differs. */
export function createTypeCatalog(options: TypeCatalogOptions): TypeCatalog;
```

PostgreSQL's awkward spellings (`timestamp(3) with time zone`, `character varying(30)`) never
reach the generic matcher: the importer runs on `libpg-query`, which hands back normalised
catalog names (`pg_catalog.timestamptz`), and the engine maps those to descriptor ids at import
time before calling `buildRef`. Anything created in the UI comes from the picker, which also
goes through `buildRef`. An unrecognised name resolves to `unknown` and survives verbatim.

Because `TypeRef` is already structured, `createTypeCatalog` does no string parsing at all in
the common path — it matches `ref.name` against descriptor ids and aliases (case-insensitively,
after `normalizeAliases`), maps `ref.args` positionally onto `descriptor.parameters`, and falls
back to `ctx.customTypes`. `arraySyntax` is used only by `format()` when it renders a label.

### 5.3 What core does with a `ResolvedType`

| surface | uses |
| --- | --- |
| type badge on the canvas | the engine's `TypeBadge` component, given `resolve(ref, ctx)`; core never renders a type label itself |
| field inspector | `descriptor.parameters` + `args` to render length/precision/scale inputs |
| link drawing | `areCompatible` on the two endpoints |
| AI context serialiser | `format(resolve(ref, ctx))` (short spellings are cheaper tokens) |
| validator | `status === 'unknown'`, or `customType === null` with a non-null `ref.customTypeId`, becomes a diagnostic with a quick fix to the nearest match |
| export | `format()` |
| assembly / import / picker | `buildRef()` — the only writer of a canonical `TypeRef` |

### 5.4 User-defined types fold into the same picker

`listPickerOptions` returns builtins and user types as one list; the picker only knows about
groups, never about enums.

```ts
export interface TypePickerOption {
  /** the ref the picker writes to Field.type once parameters are filled in; built by
   *  typeCatalog.buildRef, so it is already canonical */
  readonly value: TypeRef;
  readonly label: string;           // 'varchar(n)' | 'order_status'
  /** the picker's <optgroup>; built from TypeCategory for builtins and from
   *  terminology.customTypeKindTerms[kind].other for user types ('Enums', 'Domains') */
  readonly group: string;
  readonly parameters: readonly TypeParameterDescriptor[];
  readonly supportsArray: boolean;
  readonly summary: string;         // 'Status of an order: pending, paid, refunded'
  /** non-null for user-defined types; lets the picker deep-link to the type's own editor */
  readonly customTypeId: Id | null;
  readonly deprecated: boolean;
}
```

Custom types appear only when their `CustomTypeKindDescriptor.usableAsFieldType` is true, so a
paradigm with non-field-usable user types (a Cassandra UDT used only in collections, say) is
expressible without a core change.

---

## 6. `propsSchemas` — validating `engineProps` without importing an engine

```ts
// packages/engine-sdk/src/props.ts
export type EngineProps = Record<string, unknown>;

/** Resolved per sub-kind, because a table and a view genuinely have different props, as do a
 *  foreign key and an embedded-document link. subKind is Entity.kind / Link.kind /
 *  CustomType.kind, and null for kinds that have no sub-kind. */
export type EnginePropsResolver = (subKind: string | null) => z.ZodType<EngineProps>;

export type EnginePropsSchemas = Readonly<Record<EnginePropsKind, EnginePropsResolver>>;

/** sugar for kinds with one schema */
export function constantProps(schema: z.ZodType<EngineProps>): EnginePropsResolver;
```

**`propsSchemas` lives on `EngineStaticFacet`, not on `EngineDefinition`.** It is zod and
nothing else — no parser, no Node built-in — so it costs the browser nothing, and the browser is
where it is most needed: the project's form stack is react-hook-form + zod (spec §2), and
property panels that cannot validate locally make every invalid `engineProps` keystroke a server
round trip. Doc 01 places it on the engine's `/static` entry in two places; this agrees with it.

**Every props schema must be `.strict()`.** An unknown key is an error, not a pass-through.
JSONB with silently accepted junk is unrecoverable a year later. The conformance suite asserts
it. The rollback hazard that `.strict()` creates — engine 1.5 adds an optional key, users set it,
ops rolls back to 1.4, and every write to a touched object 422s on an unknown key the user cannot
see or clear — is handled in §15 by comparing full semver rather than the major alone, not by
loosening this.

### 6.1 The one function core calls

```ts
export type ParseEnginePropsResult =
  | { readonly ok: true;  readonly props: EngineProps }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** Core's only path to engine props validation. Converts every zod issue into a Diagnostic
 *  whose target.propPath is the zod path, so the inspector highlights the exact input.
 *  Typed against the STATIC facet, so the identical call runs in the browser (react-hook-form
 *  resolver) and in the NestJS pipe. */
export function parseEngineProps(
  engine: EngineStaticFacet,
  kind: EnginePropsKind,
  subKind: string | null,
  value: unknown,
): ParseEnginePropsResult;
```

Core's write path, in full, in one NestJS pipe:

```ts
// apps/api/src/schema/engine-props.pipe.ts — the only core file that knows engineProps exist
@Injectable()
export class EnginePropsPipe implements PipeTransform<WriteDto, Promise<WriteDto>> {
  constructor(private readonly registry: EngineRegistryService) {}

  async transform(dto: WriteDto): Promise<WriteDto> {
    if (dto.engineProps === undefined) return dto;
    const engine = this.registry.get(dto.engineId);      // by project.engineId, never a literal
    const result = parseEngineProps(engine, dto.kind, dto.subKind ?? null, dto.engineProps);
    if (!result.ok) throw new UnprocessableEntityException({ diagnostics: result.diagnostics });
    return { ...dto, engineProps: result.props };        // store the zod-parsed value, not the input
  }
}
```

Core imports `zod` (it already does, for `contracts`) but never an engine module. The registry
is the only lookup.

**Props schema failure blocks the write; validator errors do not** (§8.1). The distinction: a
props failure means the row would be structurally wrong in JSONB. A validator error means the
design is temporarily invalid, which is a normal state mid-edit.

---

## 7. Link rules — declarative, evaluated once

```ts
// packages/engine-sdk/src/links.ts
// LinkEndpoint ({ entityId, fieldIds }) and Cardinality ('1:1'|'1:N'|'N:1'|'N:M') come from
// schema-model — engine-sdk defines no second endpoint type. There is no `role`: doc 04 §2.7
// deleted it (unpersistable, and redundant with `Link.name`, which is what the canvas labels
// an edge with).

export interface LinkCheckInput {
  readonly engine: EngineStaticFacet;
  readonly model: SchemaModel;
  /** null = "pick the first link kind that accepts these endpoints" (the canvas drag case) */
  readonly linkKindId: string | null;
  readonly source: LinkEndpoint;
  readonly target: LinkEndpoint;
}

export interface LinkCheckReason {
  readonly code: CoreMessageId;      // 'link.typeMismatch'
  readonly subject?: TermSubject;    // so the sentence says "column", not "field"
  readonly vars?: Readonly<Record<string, string | number>>;
}

export interface LinkCheck {
  readonly ok: boolean;
  readonly linkKindId: string | null;
  readonly allowedCardinalities: readonly Cardinality[];
  readonly suggestedCardinality: Cardinality | null;
  /** empty when ok. Rendered through formatMessage (§16.2), never returned as prose: these are
   *  the sentences a user reads most often — once per rejected drag — and `checkLink` lives in
   *  engine-sdk, which the `no-hardcoded-nouns` grep test did not previously reach. It does
   *  now (§16.2). */
  readonly reasons: readonly LinkCheckReason[];
  /** true when the result is 'N:M' and the chosen kind's `enforced` is true, so the canvas can offer
   *  "create a junction table" (spec 6.1) without knowing what a junction table is. Doc 04
   *  makes an N:M link representable before the junction exists, so this is a suggestion,
   *  never a block. */
  readonly needsJunction: boolean;
}

/** Pure, synchronous, isomorphic. The canvas calls it on every drag frame; the API calls it in
 *  the link create/update handler. One implementation, no drift. */
export function checkLink(input: LinkCheckInput): LinkCheck;
```

Evaluation order (each step can short-circuit with a reason): `features.links` →
kind exists → `endpointLevel` matches the presence/absence of `fieldIds` → endpoint arity equal
→ `compositeEndpoints` when arity > 1 → entity kinds in `allowedSource/TargetEntityKinds` →
`allowSelfReference` → `requireSameNamespace` → `requireTypeCompatibility` via
`typeCatalog.areCompatible` pairwise.

Endpoints with an empty `fieldIds` are legal for `endpointLevel: 'entity'` kinds and for a link
the user drew before choosing columns (doc 04 §2.7); the type-compatibility and arity rules are
skipped in that case and the validator reports the link as incomplete instead.

`suggestedCardinality`: `'1:1'` when both endpoints are unique (a PK or a unique
constraint/index covers exactly those fields), `'N:1'` when only the target side is, otherwise
the kind's `defaultCardinality`.

### 7.1 On a redacted model

The canvas only ever holds a redacted model, and `checkLink` runs on every drag frame there. Doc
04 §10.2 rule 4 says a link touching a **stub entity or a hidden field** keeps the link and
clears **both** sides' `fieldIds` together (so arity survives), while a link whose endpoint
field is merely **masked** keeps its `fieldIds` pointing at the masked field's real id. Either
way the viewer is holding endpoints whose types they cannot see, and without a rule the
evaluation order above reports "endpoint type mismatch" or dereferences a blanked type to a
viewer who did nothing wrong.

The rule, checked **before** everything else in the order:

> If `model.redacted` and either endpoint's entity carries `restricted`, or any id in either
> endpoint's `fieldIds` is absent from `model.objects.field` or resolves to a field carrying
> `restricted`, `checkLink` returns
> `{ ok: true, reasons: [], linkKindId: <the stated kind or null>, allowedCardinalities: <the
> kind's list, or all of them>, suggestedCardinality: null, needsJunction: false }`.

`ok: true` rather than `ok: false` is deliberate: the viewer is not being told the link is legal,
they are being told **not to be shown an error about an object they cannot see**. A viewer cannot
write, so a permissive answer on a read-only surface has no write-path consequence — and the
server, which holds the unredacted model, evaluates the real rules on every write. Conformance:
`links/tolerates-redacted`.

---

## 8. `EngineValidator`

```ts
// packages/engine-sdk/src/validator.ts
export interface ValidationInput {
  /** Always the UNREDACTED model. See §8.3. */
  readonly model: SchemaModel;
  /** undefined = validate the whole model. On a write, core passes the touched ids plus their
   *  immediate dependants (the entity of a changed field, links touching a changed field). */
  readonly objectIds?: readonly string[];
  readonly context: EngineContext;
}

export interface EngineValidator {
  /** Synchronous and pure: no I/O, no clock, no randomness, no mutation of the input.
   *  Returns diagnostics already sorted per the ordering contract in §2.5. */
  validate(input: ValidationInput): readonly Diagnostic[];
}
```

Synchronous on purpose: it runs inside a request handler on every write, and an async validator
invites someone to put a database call in it. There is no `trigger` field: nothing in §8.2
behaves differently per trigger, `objectIds` already carries the only distinction that matters
(scoped versus whole-model), and a field that two implementers would branch on differently is
worse than no field.

### 8.1 When core calls it

| caller | how it runs | behaviour on errors |
| --- | --- | --- |
| `SchemaService`, after a successful mutation | **synchronously, inline**, with `objectIds` scoped to the touched objects plus immediate dependants | never blocks; structured diagnostics go back in the mutation response and are broadcast over the Socket.IO room, rendered per socket (§2.4) after `VisibilityFilter` |
| `GET /projects/:id/diagnostics`, the "Validate" button, the project-health meter | **BullMQ job** — the same worker pool exports already use. Returns the cached result immediately when warm, or `202` with a job id when cold | n/a |
| `ExportService` before `exporter.export` | BullMQ, inside the export job | 422 with the diagnostics unless the request sets `force: true` (see below); warnings never block |
| `MigrationService` before `migrationGenerator.generate` | BullMQ, inside the migration job | same as export, never forced |

The split matters at the spec's stated scale. 300+ entities at ~15 fields each is roughly
4,500 fields plus indexes, constraints, links and docs — **10–20k IR objects, not hundreds**. A
pure synchronous pass over 20k objects doing per-namespace duplicate-name checks and per-link
type resolution runs in the hundreds of milliseconds to seconds, and Node has one thread: a
project-health meter that blocks the event loop stalls every other request on the instance.
Scoped write validation is small and must stay inline; whole-model validation belongs in the
worker.

`force: true` on a pre-export failure requires `schema:edit` on the project (a user who cannot
fix the errors has no business shipping a script the validator calls broken) and writes an
`activity_log` entry naming the error codes that were overridden. Without that it is an advisory
flag any caller can set, which is the same as not having a gate.

**Caching.** Diagnostics are not persisted. They are recomputed and cached in Redis under
`diag:{projectId}:{schemaRevision}:{enginePluginVersion}`, holding the **structured** form
(§2.4), which is subject-independent and therefore legitimately shared between viewers; the
sentences are rendered per recipient on the way out.

`schemaRevision` is a **cross-document dependency on doc 02**: one `schemaRevision BigInt
@default(0)` column on `Project`, incremented in the same transaction as every schema-object
write and every delete. It cannot be `max(object.version)`: a maximum is not monotonic under the
operations this app performs. Edit object B from version 3 to 4 while object A sits at 12 and the
key does not change, so a fixed error is served as still-broken and its quick fix applies a
rename to a state that no longer exists. Delete the object holding the maximum and the key
*falls*, colliding with an entry cached earlier in the session and resurrecting diagnostics from a
different schema. `enginePluginVersion` is in the key so that deploying a validator bug fix
invalidates the cache for free.

### 8.2 What belongs in the validator

Engine rules only: identifier length and reserved words, illegal type/flag combinations
(identity on a non-numeric field), unresolvable types, link endpoint violations that survived
`checkLink` (bulk import can create them), duplicate names inside a namespace, index or
constraint columns that no longer exist, and — the one core cannot see for itself —
**`engineProps` expressions referencing a renamed or deleted object**, detected by comparing the
persisted `extractReferences` output (§3.1) against the live model. An engine that could not
fully parse one of its own expressions reports that as a `warning` on the owning object, so a
partially-analysed expression is visible rather than silently under-protected.

Permission rules, name uniqueness across projects and required-docs policies are core concerns
and stay out.

### 8.3 The validator never sees a redacted model

`ValidationInput.model` is the true model, and `validate` is **server-side only**. This is not a
preference. A redacted model legitimately contains blanked type names, blanked kinds, links
degraded to zero endpoints, indexes and constraints stripped of their expression columns, and
objects whose `engineProps` were emptied by doc 05's R27 — every one of which §8.2 lists as an
error. Running the *engine* validator on a redacted model would manufacture errors out of
redaction itself.

(This is not the same obligation as doc 04 §10.2 rule 4, which says core's **structural**
validator — `validateModel` — must return no errors on a redacted model. That one holds, and
is what dense ordinal renumbering and the both-sides `fieldIds` rule exist to satisfy; there
are no ordinal gaps in a redacted model, and an earlier draft of this section claimed there
were.)

So: core validates the unredacted model, then filters the resulting diagnostics through
`VisibilityFilter` (drop by `target`, rewrite `params` — §2.4). A diagnostic about an object the
subject cannot see never leaves the server, and the subject is never shown an error caused by
their own permissions. The type system carries this: `validate` takes `SchemaModel`, while
`exporter.export`, `queryValidator.validate` and `aiProfile.serializeContext` take
`RedactedModel` (§2.1).

---

## 9. `Importer`

The load-bearing rule: **an importer accounts for every statement in the source.** It may
refuse a statement, but it may never be silent about it.

```ts
// packages/engine-sdk/src/importer.ts
export interface ImportOptions {
  /** must match an ImportFormatDescriptor.id from capabilities.importFormats */
  readonly format: string;
  /** namespace for objects the source does not qualify; defaults to
   *  capabilities.defaultNamespaceName */
  readonly defaultNamespace: string | null;
  /** sourced from `capabilities.identifiers.foldsTo`, which is already three-valued because
   *  Oracle and DB2 fold up — both are in COMING_SOON */
  readonly caseFolding: 'preserve' | 'lower' | 'upper';
  /** format-specific knobs; validated by the engine, reported as diagnostics */
  readonly engineOptions: Readonly<Record<string, unknown>>;
}

/** Flattened: the previous shape wrapped one field around EngineContext and produced
 *  `ctx.context.projectId` at every call site. */
export type ImportContext = EngineContext & {
  /** id factory. Production passes the **production cuid generator**, so the ids the importer
   *  mints are final; the conformance harness passes a seeded counter so importer output is
   *  byte-comparable across runs. */
  readonly newId: () => Id;
};

export type ImportStatementStatus =
  | 'applied'      // fully represented in the returned IR
  | 'partial'      // represented with loss (reason says what was dropped)
  | 'unsupported'  // understood, deliberately not modelled (CREATE TRIGGER)
  | 'ignored'      // understood, intentionally irrelevant (SET, BEGIN, COMMENT re-applied later)
  | 'failed';      // could not be parsed

export interface ImportStatementReport {
  /** 0-based, contiguous, source order */
  readonly ordinal: number;
  /** engine-native statement label: 'CREATE TABLE', 'CREATE TRIGGER', 'unparsed' */
  readonly kind: string;
  readonly range: SourceRange;
  /** first 200 characters, whitespace-collapsed — what the report list shows */
  readonly excerpt: string;
  readonly status: ImportStatementStatus;
  /** REQUIRED (non-null) whenever status !== 'applied'. Plain language, shown verbatim:
   *  'Triggers are not part of the schema model' */
  readonly reason: string | null;
  readonly producedObjects: readonly IrObjectRef[];
}

export interface ImportReport {
  readonly statementCount: number;
  readonly statements: readonly ImportStatementReport[];
  readonly countsByStatus: Readonly<Record<ImportStatementStatus, number>>;
  readonly objectCounts: Readonly<Partial<Record<IrObjectType, number>>>;
  /** true when the source exceeded ImportFormatDescriptor.maxBytes and was cut */
  readonly truncated: boolean;
}

export interface ImportResult {
  /** A complete, standalone IR built from the source, with ids from ctx.newId(). Core persists
   *  the importer's ids UNCHANGED — they are already cuids (C1) produced by the production
   *  generator, so there is nothing to rewrite, and `producedObjects` and every diagnostic
   *  target therefore stay valid through the merge. An id-rewriting pass would have to remap
   *  `TypeRef.customTypeId`, `LinkEndpoint.fieldIds`, `IndexColumn.fieldId`,
   *  `Constraint.fieldIds`, `Field.parentFieldId` and `Entity.namespaceId` consistently, and
   *  would silently break the one feature §9.1 describes — hover a statement, highlight what
   *  it produced — for no benefit. */
  readonly model: SchemaModel;
  readonly report: ImportReport;
  readonly diagnostics: readonly Diagnostic[];
}

export interface Importer {
  import(source: string, options: ImportOptions, ctx: ImportContext): Promise<ImportResult>;
}
```

**Invariants (conformance-enforced, §17):**

1. `report.statements.length === report.statementCount`.
2. Ordinals are `0..n-1`, contiguous, ascending; `range.start` values are ascending and
   non-overlapping.
3. `status !== 'applied'` implies `reason !== null` and a non-empty reason.
4. `import()` never throws on malformed input. A source the parser cannot even split becomes a
   single `failed` statement covering the whole range.
5. Every `producedObjects` ref exists in `result.model`.

### 9.1 The report UI reads straight off this shape

```ts
const notApplied = report.statementCount - report.countsByStatus.applied;
// "3 statements could not be applied"
```

The preview dialog lists statements where `status !== 'applied'`, grouped by `kind`, each row
showing `excerpt` and `reason`, with the whole source in CodeMirror on the left and the
statement's `range` highlighted on hover. `objectCounts` drives the "will create 12 tables,
34 columns, 8 links" summary line. Nothing in that dialog is PostgreSQL-specific.

A diagnostic about the source rather than about an object — an unparseable statement, a whole
file that could not be split — targets `{ type: 'project', id: context.projectId }` with `range`
carrying the location. That is the only reason `DiagnosticTarget.type` admits `'project'`.

### 9.2 What this document does *not* decide: the merge

`ImportResult.model` is a standalone IR. Core merges it into the project, and **the merge rules
are out of scope for the engine SDK** — no part of them is engine-specific. They are named here
so the import/export document knows it owns them and two implementers do not ship two products:

1. **Collision key.** When the source defines `orders` and the project already has `orders` in
   the target namespace, what identifies them as the same object — qualified name, or nothing
   (always create a second)?
2. **Doc retention.** Does an existing entity's TipTap documentation survive a re-import that
   changes its columns?
3. **Position retention.** Does the existing canvas position survive, or does the import re-run
   auto-layout?
4. **Retargeting.** Comments, access grants and saved queries point at the *old* entity id. If a
   merge replaces the row, do those follow, or are they orphaned?

The SDK's only requirement on whatever is decided: the merge must not rewrite ids it did not
create, for the reason stated on `ImportResult.model`.

---

## 10. `Exporter`

```ts
// packages/engine-sdk/src/exporter.ts
/** Views and materialized views are ENTITIES in the IR (doc 04's PG_ENTITY_KINDS is
 *  ['table','view','materializedView']), so they are created in the `entities` phase like any
 *  other entity, in dependency order within it. There is no separate `views` phase: with one,
 *  a unique index on a materialized view — mandatory for REFRESH … CONCURRENTLY, and spec §3.4
 *  requires materialized views — landed in `indexes` *before* the matview existed, producing
 *  invalid DDL deterministically. Dropping the phase also removes a phase/IR mismatch. */
export const EXPORT_PHASE_ORDER = [
  'header', 'drops', 'namespaces', 'custom-types', 'entities', 'constraints',
  'indexes', 'comments', 'footer',
] as const;
export type ExportPhase = (typeof EXPORT_PHASE_ORDER)[number];

export interface ExportOptions {
  readonly format: string;              // an ExportFormatDescriptor.id
  readonly includeComments: boolean;
  readonly includeDrops: boolean;
  readonly includeIfNotExists: boolean;
  readonly engineOptions: Readonly<Record<string, unknown>>;
}

export interface ExportInput {
  /** ALREADY redacted by VisibilityFilter — the branded type is the enforcement (§2.1), so a
   *  raw model does not typecheck here. The exporter sees exactly what the requester may see,
   *  so exports respect permissions without the engine knowing permissions exist. §10.3 states
   *  what the engine must do about it. */
  readonly model: RedactedModel;
  readonly options: ExportOptions;
  readonly context: EngineContext;
}

export interface ExportStatement {
  readonly ordinal: number;
  readonly phase: ExportPhase;
  readonly kind: string;                // 'CREATE TABLE', 'COMMENT ON COLUMN'
  /** no trailing separator, no trailing newline */
  readonly text: string;
  readonly target: IrObjectRef | null;
}

export interface ExportResult {
  readonly statements: readonly ExportStatement[];
  /** the exporter's own `capabilities.queryLanguage.statementSeparator`, copied here so
   *  `renderStatements` has a path to it from its arguments. Previously the documented default
   *  was unreachable and every caller passed a separator by hand — which is exactly the drift
   *  centralising the field was meant to prevent. */
  readonly separator: string | null;
  /** true when redaction removed or altered anything (§10.3). Core shows "this export is
   *  incomplete" in the download dialog. Deliberately a boolean and not a count: doc 05 §8.4
   *  L8 requires every aggregate to be computed post-redaction, and "14 objects omitted" is an
   *  aggregate over what the user cannot see. */
  readonly incomplete: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface Exporter {
  export(input: ExportInput): Promise<ExportResult>;
}

/** Joins with `result.separator` and a blank line between phases. */
export function renderStatements(result: ExportResult, options?: {
  readonly separator?: string;          // default: result.separator
  readonly phaseHeadings?: boolean;     // default false; true emits '-- Tables' style comments
}): string;
```

### 10.1 The stable ordering contract

Exported statements are ordered by:

1. `EXPORT_PHASE_ORDER.indexOf(phase)`.
2. Within a phase, dependency order: a custom type before the entity that uses it, an entity
   before a foreign key that references it, a table before a view that selects from it, and a
   view before a view that selects from *it*. The engine computes this; cycles (mutual FKs)
   break by emitting the constraints in the `constraints` phase, where the tables already exist.
   Because views and materialized views are entities, an index on a materialized view is
   automatically after its target — the `indexes` phase follows `entities`.
3. Ties broken by `(namespaceName, objectName, id)`, ascending, byte comparison — never
   `localeCompare`, whose result depends on the server's ICU data.

The consequence, which is the point: **the same IR and the same options produce byte-identical
output on every machine, and re-ordering the arrays inside the IR changes nothing.** Diffing two
exports is then a real diff of the schema. The conformance suite tests both properties.

### 10.2 `COMMENT ON` generation

Documentation is already on the IR: `Area`, `Entity` and `Field` carry
`doc: DocRef | null`, and a `DocRef` is `{ id, excerpt }` where `excerpt` is the flattened
TipTap text truncated to `DOC_EXCERPT_CHARS` (200) by the docs module on write (doc 04 §2.3).
So there is **no doc map parameter** — for each object where `'doc' in object && object.doc
!== null`, and only when `options.includeComments && capabilities.features.comments`, the
exporter emits one statement in the `comments` phase with `target` set, from
`object.doc.excerpt`. Text is escaped by the engine (PostgreSQL: single quotes doubled,
dollar-quoting when the text contains quotes). Ordering inside the phase follows rule 3
above, so comments appear grouped by object in a stable order.

Two consequences of `DocRef` carrying an excerpt rather than the full text, both deliberate:
a `COMMENT ON` is at most 200 characters (doc 04 §12 sizes the whole IR on that cap — the
full prose would be megabytes in every project open, broadcast and snapshot), and there is
no `doc.facts`, because doc 04 deleted `FieldDocFacts` from the IR. The structured field
facts live in doc 02's `docs.structured` and are a docs-endpoint read. If a customer wants
full-fidelity comments in an export, the fix is a doc map on `ExportInput` filled by the
export job from the `docs` table — additive, and flagged in Open questions.

Core hides the "Include documentation as comments" checkbox off `features.comments`, the same
flag the exporter reads, so the two never disagree.

### 10.3 Exporting a redacted model

An export of a redacted model **is not a runnable schema**, and the honest failure mode is a file
that says so rather than one that looks complete and corrupts a database. The rules, which the
conformance suite tests:

1. **An object carrying `restricted.level` of `'stub'` or `'masked'` is skipped** — and so is
   anything that depends on it. Concretely: a link either of whose endpoint entities is a stub is
   skipped; a constraint or index referencing a field absent from the model is skipped; a foreign
   key to a stub entity is skipped rather than emitted against a table that will not exist.
   **`'propsRedacted'` is the exception and is emitted**, without its `engineProps`: that object
   is fully visible to the requester and only its engine-owned *expression* was withheld (doc 05
   R27), so skipping it would delete a table the user can see. Doc 04 §10.3 states the same
   split from the IR side.
2. **A masked field is skipped, not emitted by name and type.** This reverses the earlier rule
   in this document and matches doc 05 §8.4 L11 ("`hide` semantics for fields — a masked column
   is not valid DDL"). The reason is concrete: doc 04 §10.1 blanks a masked field's `engineProps`,
   which is where its `default` lives, so emitting `salary numeric NOT NULL` without its
   `DEFAULT 0` produces a script that fails on a non-empty table or creates a column that rejects
   every insert. Masking is a *canvas* affordance — it tells a reader the column exists. Carrying
   it into DDL converts a display hint into a broken artefact.
3. **The omission is announced, without quantifying it.** When anything was skipped, the
   exporter sets `incomplete: true` and emits exactly one statement in the `header` phase:
   `-- Some objects are not included because of your access level.` No counts and no names — doc
   05 §8.4 L8 and L11 are explicit that an aggregate over hidden objects is itself the leak, so
   "omits 14 objects" is not an option however useful it would be.
4. **No per-object diagnostics for skipped objects**, for the same reason: a list of `info`
   diagnostics is a count with extra steps.

Conformance: `export/skips-restricted` (a reference model with a stub entity, a link to it, a
masked field and an index over that field produces no statement mentioning any of them) and
`export/redaction-is-announced` (the header statement is present exactly when something was
skipped, and absent otherwise).

---

## 11. `MigrationGenerator`

### 11.1 `AnnotatedDiff` — a comment is not a guardrail

`MigrationInput.diff` used to be a plain `SchemaDiff` with a comment saying it had already been
through `annotateDiff`. Nothing enforced that, and the cost of the path that skips it is data
loss: a caller that builds a plan from `diffModels(before, after)` directly — the
snapshot-compare endpoint, an export job, a future CLI — gets a diff where every `destructive` is
`undefined`, so `commentedOut` is `false` even with `allowDestructive: false`, the UI renders
`DROP COLUMN` in black rather than red, and the user runs it against production.

```ts
/** Produced only by `engine.annotateDiff`, required by the migration generator. An unannotated
 *  diff does not typecheck into a migration. */
export type AnnotatedDiff = SchemaDiff & {
  readonly annotatedBy: EngineId;
  /** Risk at ENTRY level, keyed `${objectType}:${id}`. doc 04's `PropertyChange` array exists
   *  only on `changed` entries, so `added` and `removed` entries had nowhere to carry
   *  destructiveness — which made `migration/drops-are-destructive` unsatisfiable by reading
   *  the diff, since a DROP TABLE contributes zero destructive PropertyChanges. This side map
   *  gives every entry a home without changing doc 04's types. */
  readonly entryRisk: Readonly<Record<string, { readonly destructive: boolean; readonly note?: string }>>;
};

/** The rule core and the generator both read:
 *  - `changed` entries: `PropertyChange.destructive` per property, plus `entryRisk` for the
 *    entry as a whole;
 *  - `added` / `removed` entries: `entryRisk` only.
 *  `annotateDiff` must populate `entryRisk` for every `removed` entry of a namespace, entity,
 *  field or custom type with `destructive: true` — that is core's pre-set (doc 04 §7.7),
 *  carried across the annotation boundary rather than lost at it. */
export function entryIsDestructive(diff: AnnotatedDiff, entry: DiffEntry): boolean;
```

`annotateDiff` may refine `PropertyChange.severity` downward but never upward, where "downward"
means `PROPERTY_SEVERITY_RANK[after] <= PROPERTY_SEVERITY_RANK[before]` (§2.1). Without that
exported rank the conformance check `diff/annotate-never-raises-severity` could not be written.

### 11.2 The generator

```ts
// packages/engine-sdk/src/migration.ts

/** Migrations get their own phase vocabulary rather than borrowing the exporter's. There is no
 *  correct export phase for `ALTER TABLE ADD COLUMN`, and an ordering guarantee that depends on
 *  an arbitrary choice is not a guarantee. */
export const MIGRATION_PHASE_ORDER = ['pre', 'drops', 'alters', 'creates', 'post'] as const;
export type MigrationPhase = (typeof MIGRATION_PHASE_ORDER)[number];

export interface MigrationOptions {
  /** false = destructive steps are still emitted, but commented out and flagged, so the user
   *  gets a complete script they must consciously edit */
  readonly allowDestructive: boolean;
  readonly transactional: boolean;
  readonly engineOptions: Readonly<Record<string, unknown>>;
}

export interface MigrationInput {
  readonly diff: AnnotatedDiff;
  readonly before: SchemaModel;
  readonly after: SchemaModel;
  readonly options: MigrationOptions;
  readonly context: EngineContext;
}

export interface MigrationStep {
  readonly ordinal: number;
  readonly phase: MigrationPhase;
  /** the machine-readable shape of the step, which is what the ordering rule sorts on. `kind`
   *  stays as free text for display. */
  readonly operation: 'create' | 'alter' | 'drop' | 'rename';
  readonly kind: string;                // 'ALTER TABLE ADD COLUMN'
  readonly text: string;
  /** irreversibly removes an object or its data */
  readonly destructive: boolean;
  /** existing values may be changed or truncated (varchar(50) -> varchar(20), int8 -> int4) */
  readonly lossy: boolean;
  /** takes a long lock / rewrites the table — the downtime warning */
  readonly requiresTableRewrite: boolean;
  /** REQUIRED whenever destructive || lossy || requiresTableRewrite. Structured like a
   *  Diagnostic (§2.3) and rendered by the same path, so a migration preview shown to a user
   *  who cannot see one of the objects involved does not name it. */
  readonly reasonCode: string | null;
  readonly reasonParams: Readonly<Record<string, DiagnosticParam>>;
  /** Every DiffEntry this step accounts for, as `IrObjectRef`s — NON-EMPTY. Not `target`: one
   *  `changed` entry on a field carrying two PropertyChanges (type narrowed AND NOT NULL added)
   *  needs two ALTER steps that would share a single `target`, and conversely one
   *  `ALTER TABLE ADD COLUMN … REFERENCES` covers a field entry and a link entry at once. */
  readonly covers: readonly IrObjectRef[];
  readonly commentedOut: boolean;       // true when destructive && !options.allowDestructive
}

export interface MigrationPlan {
  readonly steps: readonly MigrationStep[];
  readonly summary: {
    readonly total: number;
    readonly destructive: number;
    readonly lossy: number;
    readonly rewrites: number;
  };
  /** diff entries the generator could not express as a step. Same principle as the importer:
   *  never silently drop an input. The UI shows these as "2 changes need a manual step". */
  readonly unsupported: readonly {
    readonly entry: IrObjectRef;
    readonly changeCode: string;        // rendered like a Diagnostic
    readonly changeParams: Readonly<Record<string, DiagnosticParam>>;
    readonly reasonCode: string;
    readonly reasonParams: Readonly<Record<string, DiagnosticParam>>;
  }[];
  readonly diagnostics: readonly Diagnostic[];
}

export interface MigrationGenerator {
  generate(input: MigrationInput): Promise<MigrationPlan>;
}
```

**Guarantees**, all three now mechanically checkable:

1. `isEmptyDiff(diff)` implies zero steps and zero `unsupported` entries.
2. Every `DiffEntry` is **covered by at least one step** (via `MigrationStep.covers`) **or**
   listed in `unsupported`, and never both. Not "exactly one step": the one-to-one mapping was
   false in both directions, and a correct generator failed the check that asserted it.
3. Ordering: `MIGRATION_PHASE_ORDER.indexOf(phase)`, then within a phase `drop` before `rename`
   before `create` before `alter` (by `operation`), then dependency order, then the same
   `(namespaceName, objectName, id)` byte-order tie-break as §10.1. The previous rule — "drops
   before creates inside a phase" — could not be implemented or tested, because no field
   distinguished a drop from a create and the tie-break ordered a drop and a create of the same
   object arbitrarily.

Core renders destructive steps in red and lossy ones in amber (spec §3.4) purely off the two
booleans — no parsing of the SQL text. Those booleans and the visual diff's red both trace back
to the same `annotateDiff` pass, so the two views cannot disagree.

---

## 12. `QueryValidator`

```ts
// packages/engine-sdk/src/query.ts
export type IdentifierRole =
  | 'namespace' | 'entity' | 'field' | 'alias' | 'function' | 'custom-type' | 'unknown';

export type ResolutionStatus =
  | 'resolved'     // found in the IR
  | 'alias-local'  // a query-local alias, correctly not in the IR
  | 'unknown'      // no such object
  | 'ambiguous'    // matches more than one entity in scope
  | 'not-visible'  // exists, but the user may not see it (§12.1)
  | 'unchecked';   // inside a construct the validator does not resolve (raw JSON path, CTE body)

export interface IdentifierResolution {
  /** exactly as written in the query, including quoting: "public"."orders" */
  readonly text: string;
  readonly range: SourceRange;
  readonly role: IdentifierRole;
  readonly status: ResolutionStatus;
  /** IR object id when status === 'resolved' */
  readonly targetId: Id | null;
  /** owning entity id, for fields */
  readonly entityId: Id | null;
  /** REQUIRED when status is 'unknown' | 'ambiguous' | 'not-visible'. Structured, rendered by
   *  `renderDiagnostic` (§2.4) like everything else a user reads. */
  readonly messageCode: string | null;
  readonly messageParams: Readonly<Record<string, DiagnosticParam>>;
  /** near-miss names for the CodeMirror quick fix, closest first, at most 3 */
  readonly suggestions: readonly string[];
}

export interface QueryValidationInput {
  readonly query: string;
  /** already redacted — the branded type is the enforcement (§2.1). Stubbed entities carry no
   *  name, masked fields carry no doc. */
  readonly model: RedactedModel;
  /** Optional callback that answers "is this name one I can see as a restricted stub?"
   *  **Core deliberately does not supply it** (§12.1, doc 05 L13): with no probe, a hidden
   *  object and a typo are indistinguishable, which is what makes doc 05's 404/403 rule hold
   *  without exceptions. The member stays because an engine must tolerate its absence and a
   *  future per-project setting could provide one. */
  readonly restrictedProbe?: (qualifiedName: readonly string[]) => 'hidden' | 'absent';
  readonly context: EngineContext;
}

export interface QueryParseError {
  readonly message: string;
  readonly range: SourceRange;
}

export interface QueryValidationResult {
  readonly parsed: boolean;
  readonly parseErrors: readonly QueryParseError[];
  /** every identifier the parser saw, in source order — CodeMirror underlines off this list */
  readonly identifiers: readonly IdentifierResolution[];
  /** deduped, first-appearance order: the canvas glow set (spec 6.3 step 7) */
  readonly touchedEntityIds: readonly string[];
  readonly touchedFieldIds: readonly string[];
  /** references to things the user cannot see; the AI panel shows "this query references
   *  objects you do not have access to" and refuses to copy (spec 5, AI respects permissions) */
  readonly hiddenReferences: readonly { readonly text: string; readonly range: SourceRange }[];
  /** 'SELECT', 'UPDATE', 'aggregate', 'MATCH' — core warns generically when a generated query
   *  is not read-only */
  readonly statementKinds: readonly string[];
}

export interface QueryValidator {
  validate(input: QueryValidationInput): Promise<QueryValidationResult>;
}
```

### 12.1 Hidden-object detection: the field exists, and **core does not implement it**

`restrictedProbe` stays in the input type as an optional member, and **core passes nothing**.
Every identifier that does not resolve against the redacted IR is `unknown`, exactly like a typo.
This is doc 05's L13 and its property test P8, and it is the resolution of what was an open
disagreement between the two documents.

The argument that lost was "it leaks no more than the canvas, which already shows restricted
stubs". Per doc 04 §10.1 a stub appears only for an entity that is the endpoint of a link to
something the subject can already see; a hidden entity with no link into the visible set appears
nowhere. A probe that answers for *any* name the user types is therefore a strictly larger
oracle: paste `SELECT * FROM payroll_2024` into "Explain this query" and read existence off the
response, then repeat for `salaries`, `employee_compensation`, `stripe_keys`. Bounding it to
"only names already present as stubs in this subject's own redacted model" would make the claim
true — but it costs a probe implementation, a rate limit and an audit rule to buy a friendlier
error message, and doc 05 §10.3's 404/403 rule is unqualified precisely so that P8 can assert it
without exceptions.

So: the optional member survives (an engine may not call it, and a future per-project setting
could supply one), core never provides it, and `AiModule` constructs `QueryValidationInput`
without the field. Turning it on later is one line in `VisibilityFilter` plus a decision that is
not the default.

`validate` never throws. An unparseable query returns `parsed: false` with `parseErrors`, and
whatever identifiers the parser recovered.

---

## 13. `AiProfile`

```ts
// packages/engine-sdk/src/ai.ts
export type AiMode = 'query' | 'explain' | 'draft-docs' | 'draft-schema';

export interface AiPromptContext {
  readonly projectName: string;
  readonly serverVersion: string | null;
  readonly mode: AiMode;
}

export interface AiContextOptions {
  /** The user's canvas selection (spec §6.3 step 1). Empty = the whole visible model. Without
   *  it the trimming order in §13.2 is unimplementable — every step that actually frees tokens
   *  on a 300-entity project is selection-aware. */
  readonly selectedEntityIds: readonly Id[];
  readonly includeDocs: boolean;
  readonly includeIndexes: boolean;
  readonly includeCustomTypes: boolean;
  /** per-object doc truncation, default 240 characters */
  readonly maxDocChars: number;
  /** soft cap; the serialiser trims in a fixed order until it fits (§13.2) */
  readonly tokenBudget: number;
}

export interface AiSerializedContext {
  readonly text: string;
  /** cheap heuristic (chars/3.6 for this format), used for budget decisions and usage logging */
  readonly approxTokens: number;
  /** what the budget forced out, so the UI can say "documentation trimmed to fit" */
  readonly omitted: readonly {
    readonly what: 'docs' | 'indexes' | 'fields' | 'entities';
    readonly count: number;
  }[];
}

export type AiParsedOutput =
  | {
      readonly mode: 'query' | 'explain';
      /** null when the model produced no query block (it refused, or asked a question) */
      readonly query: string | null;
      readonly explanation: string;
      readonly assumptions: readonly string[];
      readonly parseWarnings: readonly string[];
    }
  | {
      /** spec §6.2: reviewable per-field doc suggestions, accepted or rejected one at a time */
      readonly mode: 'draft-docs';
      readonly suggestions: readonly {
        readonly target: IrObjectRef;
        readonly plainText: string;
        /** The structured field-doc slots — business meaning, allowed values, examples, unit —
         *  when the model filled them. They live in doc 02's `docs.structured` column, NOT on
         *  the IR: doc 04 deleted `FieldDocFacts` because shipping allowed-values and examples
         *  for 3,000 fields is megabytes of prose in every project open. Core writes an accepted
         *  suggestion through the docs endpoint, which owns that column. */
        readonly facts?: Readonly<Record<string, string>>;
      }[];
      readonly parseWarnings: readonly string[];
    }
  | {
      /** spec Phase 5: "AI schema generation from a description". Deliberately NOT a parsed
       *  IR: the model emits native DDL and core routes it straight back through
       *  `importer.import`, which already accounts for every statement (§9) and already has a
       *  preview dialog. A second path from model output to IR would be a second place to get
       *  schema construction wrong. */
      readonly mode: 'draft-schema';
      readonly source: string;
      readonly importFormat: string;      // an importFormats id
      readonly parseWarnings: readonly string[];
    };

export interface AiProfile {
  buildSystemPrompt(ctx: AiPromptContext): string;
  serializeContext(model: RedactedModel, options: AiContextOptions): AiSerializedContext;
  /** Appended verbatim to the system prompt, per mode: which tags to emit and in what order.
   *  All four modes are declared because all four exist in the spec (§6.2, §6.3, Phase 5) and
   *  a mode with no output contract is a Phase-5 feature with no home. */
  readonly outputInstructions: Readonly<Record<AiMode, string>>;
  /** tolerant: accepts a bare fenced code block as the query and records a warning */
  parseOutput(text: string, mode: AiMode): AiParsedOutput;
  /** optional; defaults to defaultJoinPaths (§13.4) */
  suggestJoinPaths?(input: JoinPathInput): readonly JoinPathSuggestion[];
}
```

There is no `AiOutputFormat` wrapper and no `kind: 'tagged-blocks'` discriminant. A
single-member union that nothing switches on is a seam with one implementation (C12); the format
is tagged blocks for every engine, so **core owns the parser** and the engine contributes only
the instructions. See §13.3.

### 13.1 The context serialisation format: SCS (SchemaLoom Compact Schema)

One line per object, two-space indent for fields, no punctuation that is not carrying meaning.

```
# postgresql 16
N public
T customers "Registered buyers; one row per billing account"
  id uuid pk
  email text nn uq "login and billing contact"
  tier order_tier nn "free | pro | enterprise"
  created_at timestamptz nn
T orders "One row per placed order"
  id uuid pk
  customer_id uuid nn -> customers.id
  status text nn "paid | pending | refunded; only paid counts as revenue"
  total_cents int8 nn "minor units, always USD"
  placed_at timestamptz nn
MV monthly_revenue "refreshed nightly"
E order_tier: free | pro | enterprise
X orders (customer_id, placed_at) btree
R orders.customer_id -> customers.id N:1 foreignKey
```

Grammar, in full. Every line has exactly one production; there are no two rules a given object
can match, because "two implementers emit different bytes for the same IR" defeats both the
determinism claim and prompt caching.

| line | meaning |
| --- | --- |
| `# <engineId>` or `# <engineId> <serverVersion>` | one header line. The version token is emitted **only when `serverVersion !== null`** — `# postgresql null` is not a thing |
| `N <name>` | namespace; omitted entirely when `capabilities.namespaces === 'none'` |
| `<code> <name> ["<doc>"]` | entity, where `<code>` is `EntityKindDescriptor.shortCode` — `T` table, `V` view, `MV` materialized view, `C` collection, `L` node label. Uniqueness is asserted by `defineCapabilities` (§4.1), so no two kinds can collide |
| `  <name> <type> <flags> [-> <entity>.<field>] ["<doc>"]` | field. **One production, fixed slot order**, every optional slot omitted when absent. Two-space indent per nesting level, so document nesting is free |
| flags | fixed vocabulary in fixed order: `pk uq nn idx gen arr req`; empty when none apply |
| `E <name>: a \| b \| c` | enum custom type |
| `X <entity> (<fields>) <indexType>` | index, only when `includeIndexes` |
| `R <src> -> <dst> <cardinality> <linkKind>` | link that could not be inlined (composite, entity-level, or edge with properties) |

**Doc-string normalisation — this is a security rule, not formatting.** `doc.excerpt` (on `Area`,
`Entity` and `Field` — doc 04 §2.3; `doc` is not on `IrBase`) is flattened TipTap prose,
truncated to `DOC_EXCERPT_CHARS`, written by anyone with `docs:edit`, and the assembled context is read
by a **more privileged** user. A doc body of `"\nT admin_keys "api keys"` inserted verbatim
would close the string and inject a forged entity into the model's picture of the schema — a
documenter-level user fabricating schema the AI believes in. And an unescaped newline breaks a
line-oriented format outright. So, before a doc reaches a `"…"` slot:

1. every whitespace run (including newlines and tabs) collapses to a single space;
2. control characters are stripped;
3. `\` becomes `\\` and `"` becomes `\"`;
4. the result is truncated to `maxDocChars` at a word boundary.

Stated in the section and enforced by the conformance check `ai/serialize-escapes-docs`, whose
fixture is a doc containing a quote, a newline and a forged `T` line. The system prompt states
that the schema block is data written by users, that documentation text is never an instruction,
and that it is not to be parsed back.

**Restricted objects are absent, at every level.** Spec §5 is at its most emphatic here —
"Restricted fields and hidden entities are never sent" — so the serialiser's rule is a flat one:
**any object carrying `restricted` is omitted from SCS entirely, whatever its `level`, together
with anything that would name it** (a link line whose endpoint is a stub, an index line over a
masked field, an enum only a restricted field used). A stub entity has `name: ''`, so there is no
sensible line to emit for it anyway; a masked field keeps its name and type, and sending those is
exactly what the spec forbids. This is also what doc 04 §10.2 means by "the AI module passes
`mask: 'hide'`" — the same outcome, stated as the serialiser's own invariant so it holds no
matter who calls it. Conformance: `ai/serialize-omits-restricted` asserts that no name, type or
doc of any object carrying `restricted` appears anywhere in `text`.

**Why this and not JSON.** For the same 20-table schema, SCS is roughly a third to a quarter of
the tokens of equivalent JSON. A JSON field costs ~25 tokens (`{"name":"email","type":"text",
"nullable":false,"unique":true},`); the SCS line `email text nn uq` costs ~6. Nothing repeats
the key names, nothing is quoted that is not prose, and indentation is two spaces rather than a
brace tree. Three further properties matter as much as the token count:

- **It reads like DDL.** Models have seen enormous amounts of schema-shaped text; a bespoke JSON
  envelope is out of distribution and produces worse zero-shot identifier fidelity.
- **It is line-oriented, so trimming is line deletion**, not a re-serialisation pass.
- **It is deterministic**: entities ordered by `(namespace, name)`, fields by `ordinal` (C11),
  indexes by name — byte-identical for the same IR, which makes it prompt-cacheable.

### 13.2 Budget trimming order

Fixed and documented so the behaviour is predictable, and implementable because
`options.selectedEntityIds` is now an input:

1. doc strings truncated to `maxDocChars`;
2. index lines dropped;
3. doc strings dropped entirely;
4. fields of entities **not in `selectedEntityIds`** reduced to key and link fields only;
5. entities not in `selectedEntityIds` and not a link neighbour of one, dropped whole;
6. remaining unselected link neighbours dropped whole.

Each drop appends to `omitted`. Selected entities and their key/link fields are never dropped;
if the selection alone exceeds the budget, the serialiser returns it anyway and core surfaces
"your selection is too large" (spec §6.3 has the UI for this already, since step 4 offers to add
entities). An empty `selectedEntityIds` means the whole visible model is "selected", so steps 4–6
are no-ops and a big project simply blows the budget — which is the honest answer, and the
signal core needs to tell the user to select something.

### 13.3 Output format: tagged blocks

```
<query>
SELECT ...
</query>
<explanation>
One or two sentences.
</explanation>
<assumptions>
- used status = 'paid' based on the documentation on orders.status
</assumptions>
```

XML-ish tags rather than JSON because the response is **streamed over SSE** (spec §6.3 step 5):
the query block can be rendered into CodeMirror as it arrives, whereas a half-written JSON
string is unparseable and a partially-escaped SQL string is unreadable. Tags also avoid
escaping quotes and newlines in the query, and Claude follows them very reliably.

**Core owns the streaming parser, and the SDK ships it**, because the justification above is
only delivered if something can actually consume a partial response — otherwise every consumer
hand-rolls a tag splitter and the "it streams" argument is decoration. Since the format is
tagged blocks for every engine, there is exactly one splitter:

```ts
export type AiOutputEvent =
  | { readonly type: 'block-open';  readonly tag: string }
  | { readonly type: 'block-delta'; readonly tag: string; readonly text: string }
  | { readonly type: 'block-close'; readonly tag: string };

/** Incremental, allocation-light, tolerant of a chunk boundary inside a tag. Core feeds it SSE
 *  chunks and pipes `block-delta` for `query` straight into the CodeMirror document. */
export function createTaggedBlockStream(): {
  push(chunk: string): readonly AiOutputEvent[];
  end(): readonly AiOutputEvent[];
};
```

`parseOutput(text, mode)` remains for the non-streaming paths — the background doc-drafting job,
"Explain this query", replays from `ai_messages` — and is tolerant by contract: a missing
`<explanation>` yields an empty string plus a warning; a bare ```` ```sql ```` block with no tags
at all is accepted as the query with a warning. It never throws.

### 13.4 Join-path suggestions

```ts
export interface JoinPathInput {
  readonly model: RedactedModel;                // the visible model, branded (§2.1)
  readonly selectedEntityIds: readonly Id[];
  readonly maxHops: number;                     // default 3
  readonly maxSuggestions: number;              // default 5
}

export interface JoinPathStep {
  readonly linkId: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
}

export interface JoinPathSuggestion {
  readonly steps: readonly JoinPathStep[];
  /** entities the user must add to the selection for this path to work — the one-click add */
  readonly addedEntityIds: readonly string[];
  readonly connects: readonly [string, string];
  readonly reason: string; // 'orders -> order_items -> products'
}

/** BFS over Link, shortest path first, ties broken by (hop count, total added entities,
 *  entity name). Every relational and document engine uses this; a graph engine overrides it
 *  to weight by relationship type. */
export function defaultJoinPaths(input: JoinPathInput): readonly JoinPathSuggestion[];
```

`suggestJoinPaths` is optional precisely so no engine writes a second BFS. Because the model is
redacted, a join path never routes through an entity the user cannot see — the path simply does
not exist in the graph the BFS walks, which is the whole benefit of the redacted model being an
ordinary `SchemaModel`.

---

## 14. `EngineRegistry`

```ts
// packages/engine-sdk/src/registry.ts

/** Data, not code: an engine the picker advertises before any implementation exists. */
export interface AnnouncedEngine {
  readonly id: EngineId;
  readonly displayName: string;
  readonly paradigm: EngineParadigm;
  readonly icon: string;
  readonly summary: string;
}

// apps/api/src/engines/coming-soon.const.ts   (doc 01 §4.2 owns the path)
// Doc 01 puts this list server-side in EnginesModule, not in engine-sdk, and it is right:
// it is deployment policy (what we advertise), not an SDK contract. engine-sdk owns only the
// AnnouncedEngine *type* and takes the list as a constructor argument.
export const COMING_SOON: readonly AnnouncedEngine[] = [
  { id: 'mysql',     displayName: 'MySQL',      paradigm: 'relational',  icon: 'database', summary: 'MySQL 8 and MariaDB' },
  { id: 'sqlserver', displayName: 'SQL Server', paradigm: 'relational',  icon: 'database', summary: 'Microsoft SQL Server 2019+' },
  { id: 'sqlite',    displayName: 'SQLite',     paradigm: 'relational',  icon: 'database', summary: 'Embedded SQL' },
  { id: 'mongodb',   displayName: 'MongoDB',    paradigm: 'document',    icon: 'leaf',     summary: 'Collections and documents' },
  { id: 'dynamodb',  displayName: 'DynamoDB',   paradigm: 'key-value',   icon: 'zap',      summary: 'AWS key-value and document store' },
  { id: 'cassandra', displayName: 'Cassandra',  paradigm: 'wide-column', icon: 'columns',  summary: 'Wide-column store' },
  { id: 'neo4j',     displayName: 'Neo4j',      paradigm: 'graph',       icon: 'share-2',  summary: 'Nodes and relationships' },
];

/** What the picker renders for an implemented engine. Fully JSON-serialisable — this and
 *  AnnouncedEngine are the whole GET /engines payload (doc 01 §4.2). Defined as an extension
 *  so the five shared fields exist once. */
export interface EngineDescriptor extends AnnouncedEngine {
  readonly version: string;
  readonly capabilities: EngineCapabilities;
  readonly terminology: TerminologyBundle;
}

/** Matches doc 01's stated response shape exactly. */
export interface EngineCatalog {
  readonly available: readonly EngineDescriptor[];
  readonly comingSoon: readonly AnnouncedEngine[];
}

export interface EngineRegistry {
  /** throws DuplicateEngineError on a repeated id */
  register(definition: EngineDefinition): void;
  has(id: EngineId): boolean;
  /** throws UnknownEngineError — use for a project whose engine must exist */
  get(id: EngineId): EngineDefinition;
  tryGet(id: EngineId): EngineDefinition | undefined;
  list(): readonly EngineDefinition[];
  /** Registered engines become `available`; announced ids with no registration become
   *  `comingSoon`. Registration always wins, so shipping an engine needs no edit to the
   *  announcement list. Both arrays are ordered by displayName. */
  catalog(): EngineCatalog;
}

export function createEngineRegistry(
  announced: readonly AnnouncedEngine[],
): EngineRegistry;
```

A "not yet implemented" engine is therefore a row of data with no matching registration.
`EngineDefinition` carries no `status` field — status is a property of the *deployment*, not of
the engine, which is why the announcement list lives in `apps/api` and the registry derives
status by set difference.

The picker is registry-driven end to end: `GET /engines` returns `catalog()`, the UI renders one
card per entry of each array, and `comingSoon` cards are disabled with a "Coming soon" badge. No
engine id is ever written in `apps/web`.

Nest wiring, in its entirety:

```ts
// apps/api/src/engines/engines.manifest.ts  ← the ONLY file that names a concrete engine
import { postgresEngine } from '@schemaloom/engine-postgresql';
export const ENGINE_MANIFEST: EngineDefinition[] = [postgresEngine];

// apps/api/src/engines/engines.module.ts    ← core; contains no engine name
@Global()
@Module({
  providers: [
    ...ENGINE_MANIFEST.map((e) => ({ provide: ENGINE_DEFINITION, useValue: e, multi: true })),
    {
      provide: ENGINE_REGISTRY,
      inject: [ENGINE_DEFINITION],
      useFactory: (engines: EngineDefinition[]) => {
        const registry = createEngineRegistry(COMING_SOON);
        for (const engine of engines) registry.register(engine);
        return registry;
      },
    },
  ],
  exports: [ENGINE_REGISTRY],
})
export class EnginesModule {}
```

Doc 01 §4.2 owns this wiring; it is restated here so the registry contract reads on its own. The
split matters: `engines.module.ts` is core and never names an engine, so adding MySQL is one line
in `engines.manifest.ts` and a dependency, with no file under `access/`, `schema/`, `projects/`
or `transfer/` touched. The registry is `@Global()` so every module injects it without an import
graph edge, and no module ever imports an engine package.

### 14.1 The error classes

`register`, `get` and `assertFeature` are documented as throwing; `apps/api` has to catch them to
map HTTP codes, and §16.5's table already promises `assertFeature` produces a
`400 engine.feature-unsupported`. So they are declared, in `errors.ts`, each with a stable `code`
in the same `<scope>.<kebab-slug>` shape as `Diagnostic.code` so the Nest exception filter maps
on the field rather than on an `instanceof` chain.

```ts
// packages/engine-sdk/src/errors.ts
export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}

/** registry.register() with an id already present. 500 — it is a wiring bug, never user input. */
export class DuplicateEngineError extends EngineError {
  readonly engineId: EngineId;
  // code: 'engine.duplicate'
}

/** registry.get() for an unregistered id, i.e. a project whose engine package is not deployed.
 *  Core catches this one and opens the project read-only (§15), so it maps to 200 + a banner,
 *  not to an error response. */
export class UnknownEngineError extends EngineError {
  readonly engineId: EngineId;
  // code: 'engine.unknown'
}

/** assertFeature() failed. 400 `engine.feature-unsupported`. */
export class EngineFeatureUnsupportedError extends EngineError {
  readonly engineId: EngineId;
  readonly feature: EngineFeature;
  // code: 'engine.feature-unsupported'
}

/** defineCapabilities() found an internal contradiction (§4.1). Thrown at module load, so it
 *  fails the deploy rather than a request. */
export class CapabilitiesContradictionError extends EngineError {
  readonly engineId: EngineId;
  readonly rule: string;   // 'links-imply-kinds'
  // code: 'engine.capabilities-contradiction'
}
```

---

## 15. Versioning

**Two different versions, and they must not be confused.** Doc 02 and doc 04 both define
`Project.engineVersion` / `SchemaModel.engineVersion` as the **target database version** — `"16"`
for PostgreSQL 16. That is `EngineContext.serverVersion` and it has nothing to do with plugin
versions.

`EngineDefinition.version` is semver describing the **engine plugin's behaviour contract** (not
its npm version; they may coincide, nothing depends on it). The version a project's stored
`engineProps` were written for needs its own home, and it is a **real column, not a key in
`settings`**: `enginePluginVersion String @map("engine_plugin_version")` on `Project`.

That is one line in doc 02 and it is worth it for two reasons. `Project.settings` is already
owned by core, validated by core's `projectSettingsSchema`, and read on every request for
`restrictedFieldMode`; putting engine lifecycle state in the same JSON blob gives one column
three owners and one zod schema, and any read-modify-write of it loses a concurrent settings
change. And "find every project that needs attention after this deploy" becomes an ordinary
indexed query instead of a JSONB scan. Snapshots need the same stamp — see below.

**Bump rules for engine authors** (documented in the SDK README, checked at review):

| change | bump |
| --- | --- |
| an `engineProps` key removed, renamed, retyped, or given new meaning | major |
| a feature atom flips `true -> false`; a `TypeDescriptor.id` removed; export phase order changed | major |
| new optional `engineProps` key; new type descriptor; a feature atom flips `false -> true`; new import/export format | minor |
| bug fix, message wording, ordering fix within the documented contract | patch |

### 15.1 What the SDK does about drift, and what it deliberately does not

```ts
// packages/engine-sdk/src/versioning.ts
export type EngineVersionVerdict =
  | { readonly action: 'ok' }
  | { readonly action: 'read-only'; readonly reason: 'project-newer-than-engine' }
  | { readonly action: 'read-only'; readonly reason: 'project-older-major' }
  | { readonly action: 'read-only'; readonly reason: 'engine-missing' };

/** Full-semver comparison, not major-only. */
export function compareEngineVersion(
  storedPluginVersion: string,   // projects.engine_plugin_version
  engine: EngineStaticFacet | undefined,
): EngineVersionVerdict;
```

The rules, in full, evaluated in `ProjectsService.open()` and re-checked on every write:

| situation | verdict |
| --- | --- |
| engine not registered | `read-only / engine-missing`, rendered by the fallback UI (§16.4). Never a 500, never a lost project |
| `stored > engine.version` **at any semver level** | `read-only / project-newer-than-engine` |
| `stored.major < engine.major` | `read-only / project-older-major`, with a banner naming the two versions |
| otherwise (`stored <= engine.version`, same major) | `ok`; `engine_plugin_version` is refreshed on the next write |

**Full semver, not just the major, is the load-bearing change here.** The classic incident: 1.5
adds an optional `engineProps.compression` to the column schema, users set it on a few hundred
columns, 1.5 turns out to have a bug, ops rolls back to 1.4. Major-only comparison says `ok`, the
project opens read-write, and every subsequent write to one of those columns hits `.strict()`,
trips the unknown key, and throws 422 — an error the user cannot fix from the UI, because they
cannot see or clear a prop the current schema does not model. Comparing the whole version makes
the rollback open the project read-only with an accurate reason, which is recoverable by
redeploying. Keeping `.strict()` and stripping unknown keys instead would silently destroy the
data on the way back up. Conformance fixture: `props/rollback-is-read-only`.

**There is no `propsMigrations`, no `EnginePropsMigration`, and no upgrade-on-open transaction.**
The previous draft had all three, against an engine sitting at major 1 with zero migrations
written, and they were the source of more failure modes than the problem they solved: an
unlocked write transaction over every schema row of a project, triggered from a *read* path, so
two users opening after a deploy both ran the chain and the second applied a rename-key migration
to already-renamed props; it ran as whoever opened the project, so a Viewer triggered a
project-wide write and an `activity_log` entry attributed to them; it bumped `version` (C7) on
every row, 409-ing every editor's in-flight write with no reload broadcast; and its
`engineUpgradePending` failure flag was written *inside* the transaction that rolled back, so a
project that failed once retried the same failing upgrade on every open, forever.

The replacement is one paragraph: **a major bump opens the project read-only until someone
migrates it.** Migration, when a real breaking change first exists, is a deliberate operator
action — a BullMQ job with an advisory lock, run as a system actor, not a side effect of someone
opening a page. That job is designed in the release that needs it; the conformance suite carries
`props/rollback-is-read-only` today, and gains a `previous-major-migrates` check at the same time
the job does.

### 15.2 Snapshots carry their own stamp

A snapshot is a frozen IR blob (C3) containing `engineProps` written under whatever plugin
version was current at the time, and nothing in the live-row story touches it. A project on
major 1 takes a snapshot in March; the engine ships major 2 in June renaming
`engineProps.identity.always` to `.mode`; in July someone restores the March snapshot and every
row fails the strict major-2 schema — either a wholesale 422 or, worse, rows no subsequent edit
can save. `MigrationInput.before` is routinely an old snapshot, and so is the left side of a
snapshot diff.

So: **doc 02 dependency — `enginePluginVersion String` on `Snapshot`**, stamped on write beside
the `irSchemaVersion` it already carries. And the rule, which is fail-closed rather than clever:

> Restore, diff-against-live and migration-generation all compare the snapshot's
> `enginePluginVersion` with the registered engine using `compareEngineVersion`. A different
> **major** refuses the operation with a clear message ("this snapshot was taken with
> PostgreSQL engine 1.x; the project runs 2.x"). Same major proceeds.

Refusing is the right default while no migration machinery exists: producing a diff from props
the current schema cannot even parse yields a migration script that is wrong in ways nobody will
notice until it runs. An `ImportResult` from an older export has no version stamp at all and is
simply re-parsed by the current schemas, which is what the importer is for.

---

## 16. Frontend contract — `@schemaloom/engine-sdk/ui`

This entry is the only one that imports React types. `apps/api` never resolves it.

### 16.0 How the browser gets an `EngineStaticFacet`

Half of this section consumes a facet, and the previous draft never said where one came from:
`checkLink` takes one and runs per drag frame, `PropertyPanelProps.engine` is one, the type
catalog and terminology come from one, and `useEngine()` / `useTerminology()` appear in the
examples without ever being defined. The facet cannot arrive over the wire — `typeCatalog`
contains functions and `propsSchemas` contains zod schemas — so it must be **imported**, and
there has to be a registry keyed on `project.engineId` exactly parallel to the UI one.

```ts
// packages/engine-sdk/ui/index.ts
export type EngineFacetLoader = () => Promise<{ readonly default: EngineStaticFacet }>;

export interface EngineFacetRegistry {
  register(engineId: EngineId, loader: EngineFacetLoader): void;
  /** memoised per session. Rejects with UnknownEngineError for an unregistered id — unlike the
   *  UI registry there is no fallback, because a facet is not optional: without capabilities
   *  and a type catalog there is nothing to render. Core catches it and shows the
   *  "this project's engine is not available" state, the same one `engine-missing` (§15) uses. */
  load(engineId: EngineId): Promise<EngineStaticFacet>;
}

export function createEngineFacetRegistry(): EngineFacetRegistry;
```

```ts
// apps/web/src/engines/register.ts — 'use client'. The whole file, both registries.
import { engineFacets, engineUi } from './registry';

engineFacets.register('postgresql', () => import('@schemaloom/engine-postgresql/static'));
engineUi.register('postgresql',     () => import('@schemaloom/engine-postgresql-ui'));
// adding an engine is two more lines here, and this is the only file in apps/web that may
// contain an engine id (§16.5's grep test)
```

```tsx
// apps/web/src/engines/engine-provider.tsx
/** Mounted once per open project, above the canvas and the inspector. Resolves the facet for
 *  project.engineId and the UI plugin lazily beside it. */
export function EngineProvider(props: { engineId: EngineId; children: ReactNode }): ReactNode;

/** The facet for the open project. Throws outside an EngineProvider — every caller is inside
 *  one by construction. */
export function useEngine(): EngineStaticFacet;

/** Sugar over useEngine().terminology plus the formatter (§16.2):
 *  `{ msg, term }`, where `msg(id, subject, vars?)` is `formatMessage(bundle, …)`. */
export function useTerminology(): { msg: typeof formatMessage extends never ? never : (
  id: CoreMessageId, subject: TermSubject, vars?: Readonly<Record<string, string | number>>
) => string; term: (subject: TermSubject) => Term };
```

**Precedence, stated once so it cannot be argued about later: the imported facet is
authoritative on the client.** `GET /engines` returns `capabilities` and `terminology` too, and
that payload exists for exactly one purpose — the **engine picker**, which must render cards for
engines whose facet is not bundled (a "coming soon" row, or an engine implemented on the server
before its `/static` chunk ships). Nothing else reads capabilities from the wire. If the two ever
disagree, the mismatch is logged to the error tracker with both versions and otherwise ignored,
because a project that is already open should not change behaviour because a deploy is halfway
done.

### 16.1 `EngineUiPlugin`

```ts
// packages/engine-sdk/ui/index.ts
import type { ComponentType, ReactNode } from 'react';
import type { Extension } from '@codemirror/state';

/** PK / FK / unique are NOT field flags — doc 04 §2.6 derives them from Constraint and Link
 *  objects through the model index, so the truth lives in one place. The node renderer is the
 *  engine's, and it is the thing that draws the card spec §6.1 describes ("fields with type and
 *  PK/FK/unique/nullable badges"), so core computes the derivation ONCE per entity and hands it
 *  over. Without this the engine renderer either cannot draw the badges or re-derives them from
 *  the whole model on every canvas frame. */
export interface FieldBadges {
  readonly primaryKey: boolean;
  readonly foreignKey: boolean;
  readonly unique: boolean;
}

export interface EngineNodeProps {
  readonly entity: Entity;
  /** already ordered by `ordinal` (C11), already redacted */
  readonly fields: readonly Field[];
  readonly badges: ReadonlyMap<Id, FieldBadges>;
  readonly selected: boolean;
  readonly collapsed: boolean;
  /** Masking comes from the IR itself: a field with `restricted.level === 'masked'` keeps its
   *  name, ordinal, type and nullability (doc 04 §10.1) and renders with a lock badge and no
   *  doc indicator. The renderer reads `field.restricted` — there is no separate id set and no
   *  way to forget to apply it. */
  /** AI glow + search highlight, driven by core */
  readonly highlightedFieldIds: ReadonlySet<Id>;
  readonly areaColor: string | null;
  readonly diagnostics: readonly Diagnostic[];
  /** Supplied by core, wrapping React Flow's <Handle> with the id convention the canvas's edge
   *  layer expects (`<fieldId>:source` / `<fieldId>:target`). The engine renderer places one
   *  pair per field row and never constructs a handle itself — spec §6.1 requires
   *  drag-from-field-to-field, and the handle ids are how an edge finds its anchor.
   *  **Rule:** render it for every field when `features.links` is true; when false, core
   *  supplies a component that renders `null`, so "the canvas hides connection handles
   *  entirely" (§4.2) needs no branch in engine code. */
  readonly FieldHandle: ComponentType<{ readonly fieldId: Id; readonly side: 'source' | 'target' }>;
  readonly onFieldSelect: (fieldId: Id) => void;
  readonly onToggleCollapse: () => void;
}

export interface PropertyPanelProps<T> {
  readonly object: T;
  readonly model: SchemaModel;
  readonly engine: EngineStaticFacet;
  readonly readOnly: boolean;
  /** diagnostics already filtered to this object, already rendered to strings by core */
  readonly diagnostics: readonly Diagnostic[];
  /** the ONLY mutation path: core owns optimistic update, version bump (C7) and rollback.
   *  The panel validates locally with `engine.propsSchemas` first (zod + react-hook-form,
   *  §6), so an invalid edit costs no round trip. */
  readonly onChange: (patch: { readonly engineProps: EngineProps }) => void;
}

export interface PropertyPanelSection<T> {
  readonly id: string;               // 'pg.column.identity'
  readonly title: string;
  readonly order: number;            // ascending; core sections occupy 0, 100, 200…
  readonly defaultCollapsed: boolean;
  /** hidden automatically when the predicate is false; core evaluates it against the facet's
   *  capabilities. A predicate rather than a feature atom, for the reason in §16.5. */
  readonly available?: (caps: EngineCapabilities) => boolean;
  readonly Component: ComponentType<PropertyPanelProps<T>>;
}

export interface TypePickerProps {
  /** a TypeRef, not a string. `Field.type` is structured (doc 04 §2.6, §5 here), and Key
   *  `typeCatalog.buildRef` is the only writer of a canonical ref — a picker that emitted a
   *  bare string would force the caller to re-parse it, which is the exact drift §5 exists
   *  to prevent, and could not express `numeric(10,2)[]` or a custom-type reference at
   *  all. */
  readonly value: TypeRef;
  readonly options: readonly TypePickerOption[];         // from typeCatalog.listPickerOptions
  readonly resolved: ResolvedType;
  readonly disabled: boolean;
  /** `next` comes from `TypePickerOption.value`, or from `typeCatalog.buildRef` once the
   *  parameter inputs are filled. Never from string concatenation. */
  readonly onChange: (next: TypeRef) => void;
}

export interface TypeBadgeProps {
  readonly resolved: ResolvedType;
  readonly compact: boolean;         // true on canvas nodes, false in the inspector
}

export interface EngineUiPlugin {
  readonly engineId: EngineId;
  /** keyed by EntityKindDescriptor.id */
  readonly nodeRenderers: Readonly<Record<string, ComponentType<EngineNodeProps>>>;
  readonly defaultNodeRenderer?: ComponentType<EngineNodeProps>;
  readonly panels: {
    readonly entity?: readonly PropertyPanelSection<Entity>[];
    readonly field?: readonly PropertyPanelSection<Field>[];
    readonly link?: readonly PropertyPanelSection<Link>[];
    readonly index?: readonly PropertyPanelSection<Index>[];
    /** The CHECK body is `Constraint.engineProps.expression` and the exclusion operators are
     *  engineProps too (doc 04 §2.9). Without this panel there is no UI path anywhere in the
     *  design to author a check constraint — which spec §3.4 requires in the Phase 1
     *  PostgreSQL engine. */
    readonly constraint?: readonly PropertyPanelSection<Constraint>[];
    /** Enum labels and their order, a domain's base type and checks, a composite's attributes
     *  are all `CustomType.engineProps` (doc 04 §2.10). Same argument: spec §3.4 requires user
     *  enums, domains and composite types, and none of them is editable without this. */
    readonly customType?: readonly PropertyPanelSection<CustomType>[];
  };
  readonly TypePicker?: ComponentType<TypePickerProps>;
  readonly TypeBadge?: ComponentType<TypeBadgeProps>;
  /** lazily imports the CodeMirror language package; core wraps it in its own dynamic import */
  readonly loadEditorLanguage?: () => Promise<Extension>;
  /** optional flavour text on a rejected drag, e.g. "add a junction table for N:M" */
  readonly connectionHint?: (check: LinkCheck) => ReactNode | null;
}
```

**Where the two new panels mount.** Constraints are addressed by `IrObjectRef` like everything
else, and both surfaces already exist in the layout (spec §7):

- `panels.constraint` renders inside the entity inspector's **Constraints** tab, below the core
  section that owns `kind` and `fieldIds`. One sub-panel per selected constraint.
- `panels.customType` renders in a **Custom types** section of the left sidebar — a
  project-level list, not an entity tab, because a custom type belongs to a namespace and is
  reused across entities. Selecting one opens it in the right panel with the engine's sections.
  The section is present when `capabilities.customTypeKinds` is non-empty.

Deliberately **not** on the UI plugin:

- **Terminology and icons** live on `EngineStaticFacet` (§16.2). They are strings, not React, and
  the fallback UI needs them for an engine that ships no UI package at all.
- **`canConnect`.** The UI calls the shared `checkLink` (§7). A UI-local copy of the rules is
  exactly how drag-time and write-time behaviour drifts apart.
- **Type catalog data.** Already on the client facet; the plugin only supplies an optional
  *renderer* for it.

### 16.2 Terminology: nothing hard-codes a noun

```ts
// packages/engine-sdk/src/terminology.ts  (no React — exported from both "." and "./ui")
export interface Term {
  readonly one: string;     // Title Case singular: 'Table'
  readonly other: string;   // Title Case plural:   'Tables'
  /** overrides the derived a/an; needed for 'an index', 'a namespace' */
  readonly indefinite?: 'a' | 'an';
}

export type CoreTermKey =
  | 'namespace' | 'entity' | 'field' | 'link' | 'index' | 'constraint'
  | 'customType' | 'query' | 'area';

export interface TerminologyBundle {
  readonly terms: Readonly<Record<CoreTermKey, Term>>;
  /** keyed by EntityKindDescriptor.id — 'table' -> Table, 'view' -> View */
  readonly entityKindTerms: Readonly<Record<string, Term>>;
  /** keyed by LinkKindDescriptor.id */
  readonly linkKindTerms: Readonly<Record<string, Term>>;
  /** keyed by ConstraintKindDescriptor.id */
  readonly constraintKindTerms: Readonly<Record<string, Term>>;
  /** keyed by CustomTypeKindDescriptor.id — drives the type picker's group headings (§5.4) */
  readonly customTypeKindTerms: Readonly<Record<string, Term>>;
}
```

**The bundle is the only home for a noun.** The kind descriptors in §4 previously each carried a
`Term` as well, keyed by the same ids, with nothing saying which won and nothing keeping them in
sync — and `resolveTerm(bundle, 'entityKind:table')` had no defined behaviour when the bundle
lacked the key, so it would hand `formatMessage` an `undefined` and render "Add undefined". That
is the same duplication this document rejects three sections earlier when it refuses to put
`queryLanguage` on `aiProfile` ("duplicating it is how they diverge"), and it violates C12. So
`term` is gone from `EntityKindDescriptor`, `LinkKindDescriptor`, `ConstraintKindDescriptor` and
`CustomTypeKindDescriptor`, the bundle grew the two maps it was missing, and `defineCapabilities`
plus the conformance check `terminology/covers-all-kinds` assert that every kind id in
`capabilities` has an entry in the bundle.

There is also no `overrides` escape hatch: no consumer was ever named for it, and an engine that
can rewrite arbitrary core messages is exactly the drift Key decision 5 exists to prevent.

Core owns the **message catalog**; engines own only the **nouns**.

```ts
export type CoreMessageId =
  | 'action.add' | 'action.addFirst' | 'action.delete' | 'action.duplicate' | 'action.rename'
  | 'list.title' | 'list.empty' | 'list.count' | 'list.searchPlaceholder'
  | 'inspector.title' | 'inspector.noSelection'
  | 'confirm.delete' | 'confirm.deleteMany'
  | 'tab.details' | 'tab.docs' | 'tab.indexes' | 'tab.constraints' | 'tab.comments'
  | 'palette.jumpTo' | 'palette.create'
  | 'canvas.dropHint' | 'export.includeComments' | 'import.applyTo'
  // the rejected-drag sentences, moved out of engine-sdk prose (§7)
  | 'link.selfNotAllowed' | 'link.typeMismatch' | 'link.crossNamespace'
  | 'link.arityMismatch' | 'link.kindNotAllowed' | 'link.compositeNotAllowed'
  // rendered in place of any object ref the recipient may not see (§2.4)
  | 'diag.restrictedObject';

export const CORE_MESSAGE_TEMPLATES: Readonly<Record<CoreMessageId, string>> = {
  'action.add':            'Add {oneLower}',
  'action.addFirst':       'Add your first {oneLower}',
  'action.delete':         'Delete {oneLower}',
  'action.duplicate':      'Duplicate {oneLower}',
  'action.rename':         'Rename {oneLower}',
  'list.title':            '{other}',
  'list.empty':            'No {otherLower} yet',
  'list.count':            '{count} {oneLower|otherLower}',
  'list.searchPlaceholder':'Search {otherLower}…',
  'inspector.title':       '{one} details',
  'inspector.noSelection': 'Select {a} {oneLower} to see its details',
  'confirm.delete':        'Delete {a} {oneLower}? This cannot be undone.',
  'confirm.deleteMany':    'Delete {count} {otherLower}? This cannot be undone.',
  'tab.details':           'Details',
  'tab.docs':              'Documentation',
  'tab.indexes':           '{other}',
  'tab.constraints':       '{other}',
  'tab.comments':          'Comments',
  'palette.jumpTo':        'Jump to {oneLower}…',
  'palette.create':        'Create {a} {oneLower}',
  'canvas.dropHint':       'Drag from a {oneLower} to another to create {a} {oneLower}',
  'export.includeComments':'Include documentation as comments',
  'import.applyTo':        'Apply to {otherLower}',
  'link.selfNotAllowed':   'A {oneLower} cannot link to itself',
  'link.typeMismatch':     '{from} and {to} are not compatible types',
  'link.crossNamespace':   'Both {otherLower} must be in the same {namespace}',
  'link.arityMismatch':    'Both ends must use the same number of {otherLower}',
  'link.kindNotAllowed':   'This {oneLower} cannot link to {a} {targetLower}',
  'link.compositeNotAllowed': 'This {oneLower} supports only single-{oneLower} links',
  'diag.restrictedObject': 'a restricted object',
};
```

Placeholders: `{one}` `{other}` `{oneLower}` `{otherLower}` `{a}` (indefinite article),
`{count}`, and `{x|y}` which selects by `count` (1 → `x`, otherwise `y`). That is a ~25-line
formatter, no i18n dependency.

```ts
/** The term a message is about: a core key, or a specific entity/link kind. */
export type TermSubject =
  | CoreTermKey
  | `entityKind:${string}` | `linkKind:${string}`
  | `constraintKind:${string}` | `customTypeKind:${string}`;

/** Total. A missing key falls back to FALLBACK_TERMINOLOGY's term for the same subject, and
 *  then to the generic core term ('entity', 'link', …) — so the worst case renders "Add entity",
 *  never "Add undefined". The fallback is also logged once per key per session, because a miss
 *  means the engine and its bundle disagree and `terminology/covers-all-kinds` should have
 *  caught it. */
export function resolveTerm(bundle: TerminologyBundle, subject: TermSubject): Term;

export function formatMessage(
  bundle: TerminologyBundle,
  id: CoreMessageId,
  subject: TermSubject,
  vars?: Readonly<Record<string, string | number>>,
): string;

export const FALLBACK_TERMINOLOGY: TerminologyBundle; // Entity/Field/Link/Index/Namespace
```

Usage in core, which is all core ever writes:

```tsx
const t = useTerminology();
<Button>{t.msg('action.add', 'entity')}</Button>          // PostgreSQL: "Add table"
                                                          // MongoDB:    "Add collection"
<Button>{t.msg('action.add', 'entityKind:view')}</Button>  // "Add view"
<h2>{t.msg('list.title', 'index')}</h2>                    // "Indexes"
<p>{t.msg('list.count', 'field', { count: 12 })}</p>       // "12 columns"
```

Casing: terms are stored Title Case; the formatter lowercases for mid-sentence slots. Engines
never store two casings of the same noun.

**Enforcement.** One vitest test, `no-hardcoded-nouns.test.ts`, over `apps/web/src/**` **and
`packages/engine-sdk/src/**`** — the second root because `checkLink` lives there and its rejected-
drag sentences are the nouns a user sees most often (§7).

It is **AST-based, not a grep**: ~40 lines using the TypeScript compiler API, walking only
`JSXText` nodes and string literals that are JSX attribute values or arguments to `t.msg`-shaped
calls, matching `/\b(table|column|collection|document|node label)s?\b/i`. A regex over raw source
cannot tell a JSX text node from a variable named `table` or a Tailwind class `table-auto`, so
the allowlist would grow until it *was* the file. Two details the first draft got wrong and which
the allowlist must actually cover:

- `\bdocument\b` does not match "documentation", so that entry was never needed. The entries that
  *are* needed: the HTML `<table>` element and its children, CSS utilities (`table-auto`,
  `column-gap`), TanStack Table's API surface (`useReactTable`, `columnDef`, `getColumn`), and
  the literal word "Schema" in "Database schema" marketing copy.
- `schema` is dropped from the pattern entirely. It collides with `zodSchema`, `propsSchemas`,
  `schema-model` and half the codebase, and it is not an engine-varying noun in the product's
  voice — the product says "schema" to everyone.

The sibling check ("no engine-id string literal in `apps/web/src` outside `engines/register.ts`")
runs in the same file over the same AST, and skips `**/*.test.ts*` and `**/fixtures/**`, where
`'postgresql'` legitimately appears in mock data.

### 16.3 `EngineUiRegistry` and code splitting

```ts
export type EngineUiLoader = () => Promise<{ readonly default: EngineUiPlugin }>;

export interface EngineUiRegistry {
  register(engineId: EngineId, loader: EngineUiLoader): void;
  /** memoised; resolves to FALLBACK_ENGINE_UI when unregistered or when the import fails */
  load(engineId: EngineId): Promise<EngineUiPlugin>;
}

export function createEngineUiRegistry(): EngineUiRegistry;
export const FALLBACK_ENGINE_UI: EngineUiPlugin;
```

There is no `peek()`. Its only stated use was a synchronous render path under Suspense, and
`use(engineUiPromise(id))` below does not need one.

```ts
// apps/web/src/engines/registry.ts — the whole file
import { createEngineFacetRegistry, createEngineUiRegistry } from '@schemaloom/engine-sdk/ui';
export const engineFacets = createEngineFacetRegistry();
export const engineUi = createEngineUiRegistry();
```

Registration is `apps/web/src/engines/register.ts`, shown in §16.0.

Doc 01 sketches this registry as `Map<engineId, EngineUiPlugin>` with `register.ts` importing
the UI package directly. That is a static import, so every engine's UI lands in the first
bundle. The only change here is that the map holds a **loader** instead of a plugin: same two
files, same one-line registration, but the chunk is deferred. If the reviewer would rather keep
eager imports until there is a second engine, the registry interface is unchanged —
`register('postgresql', () => Promise.resolve({ default: postgresEngineUi }))`.

`() => import(...)` is a real dynamic import, so the bundler emits `engine-postgresql-ui` as its
own chunk that a user who only opens a MongoDB project never downloads. The registry memoises
the promise, so the chunk is fetched once per session.

```tsx
// apps/web/src/engines/use-engine-ui.ts
/** Memoised per engine id, so `use()` gets the same promise identity on every render. */
const engineUiPromise = (id: EngineId): Promise<EngineUiPlugin> => engineUi.load(id);

export function useEngineUi(): EngineUiPlugin {
  const { id } = useEngine();              // the facet from EngineProvider (§16.0)
  return use(engineUiPromise(id));         // React 19 `use`, under the project-level <Suspense>
}
```

Load failure (a bad deploy, an offline chunk) is caught inside `load()`: it logs, reports to the
error tracker, and resolves `FALLBACK_ENGINE_UI`. A broken UI plugin degrades the inspector; it
never white-screens a project.

### 16.4 The fallback plugin

`FALLBACK_ENGINE_UI` renders a generic entity card (name header, one row per field showing name,
`typeCatalog` badge, the derived PK/FK/unique badges from `EngineNodeProps.badges` and a
`FieldHandle` pair), contributes no extra panel sections, uses a plain `<Select>` type picker
driven by `listPickerOptions`, and supplies no editor language (CodeMirror falls back to plain
text). Because terminology, capabilities, the type catalog **and `propsSchemas`** come from the
client facet (§16.0) and not the plugin, **a backend-only engine is fully usable on day one** —
correct nouns, correct feature gating, working type picker, and even generic engineProps forms
generated from the zod schemas — and its UI package is a polish step, not a blocker. That is what
makes "add an engine without touching core" true in practice rather than on paper.

### 16.5 Worked capability gate: the Indexes panel

Suppose a Cassandra engine registers with `features.indexes: false`.

**One declaration** drives every surface:

```ts
// apps/web/src/components/inspector/tabs.ts
export interface InspectorTab {
  readonly id: string;
  readonly messageId: CoreMessageId;
  readonly subject: TermSubject;
  /** A predicate, not a single feature atom. The first draft gated Constraints on
   *  `requires: 'checkConstraints'`, so an engine with primary keys but no CHECK — SQLite in
   *  older modes, DynamoDB, most document stores — lost the entire Constraints tab including
   *  primary-key editing. One atom per tab cannot express "any of these". */
  readonly available?: (caps: EngineCapabilities) => boolean;
}

export const INSPECTOR_TABS: readonly InspectorTab[] = [
  { id: 'details',     messageId: 'tab.details',     subject: 'entity' },
  { id: 'docs',        messageId: 'tab.docs',        subject: 'entity' },
  { id: 'indexes',     messageId: 'tab.indexes',     subject: 'index',
    available: (c) => c.features.indexes },
  { id: 'constraints', messageId: 'tab.constraints', subject: 'constraint',
    available: (c) => c.constraintKinds.length > 0 },
  { id: 'comments',    messageId: 'tab.comments',    subject: 'entity' },
];

export const visibleTabs = (caps: EngineCapabilities): readonly InspectorTab[] =>
  INSPECTOR_TABS.filter((t) => !t.available || t.available(caps));
```

Sections *inside* a tab carry their own `available` (`PropertyPanelSection.available`), so an
engine with primary keys but no exclusion constraints gets the tab with one fewer section rather
than no tab. Same mechanism, one level down.

```tsx
// apps/web/src/components/inspector/entity-inspector.tsx
const { capabilities } = useEngine();
const tabs = visibleTabs(capabilities);
return (
  <Tabs.Root defaultValue={tabs[0].id}>
    <Tabs.List>
      {tabs.map((t) => (
        <Tabs.Trigger key={t.id} value={t.id}>{term.msg(t.messageId, t.subject)}</Tabs.Trigger>
      ))}
    </Tabs.List>
    {/* … */}
  </Tabs.Root>
);
```

For anything that is not a tab, the generic gate:

```tsx
export function CapabilityGate(props: {
  /** exactly one of the two: an atom for the ten headline features, or a predicate for
   *  anything answered by a descriptor list (`(c) => hasConstraintKind(c, 'check')`) */
  readonly feature?: EngineFeature;
  readonly when?: (caps: EngineCapabilities) => boolean;
  readonly children: ReactNode;
  readonly fallback?: ReactNode;
}): ReactNode {
  const { capabilities } = useEngine();
  const ok = props.feature ? capabilities.features[props.feature] : props.when!(capabilities);
  return ok ? props.children : (props.fallback ?? null);
}
```

The full chain for `features.indexes === false`, with no engine-specific code anywhere:

| surface | mechanism |
| --- | --- |
| inspector tab | `visibleTabs` filters it out |
| left sidebar "Indexes" section | `<CapabilityGate feature="indexes">` |
| command palette "Add index" | palette entries carry the same optional `available` predicate, filtered by one shared helper |
| canvas node index affordance | `<CapabilityGate feature="indexes">` inside the core node chrome |
| export dialog "include indexes" | `<CapabilityGate feature="indexes">` |
| keyboard shortcut | registered through the same command table, so it disappears with the entry |
| API `POST /projects/:id/indexes` | `assertFeature(engine, 'indexes')` → 400 `engine.feature-unsupported` |

UI gating is convenience; the server check is the guarantee. And the standing rule: **every core
feature some engine might lack is declared in exactly one table, with one `available` predicate
over `EngineCapabilities`.** The sibling AST check (§16.2) asserts no `engineId ===` comparison
and no engine-id string literal exists in `apps/web/src` outside `engines/register.ts`.

---

## 17. Engine conformance test suite

Shipped from `@schemaloom/engine-sdk/conformance`. Every engine package has exactly one test file
that calls it. An engine that does not pass is not registered.

```ts
// packages/engine-sdk/conformance/index.ts
export interface RoundTripFixture {
  readonly name: string;
  readonly format: string;                        // an importFormats id
  readonly source: string;
  /** statement kinds the fixture expects to be reported non-'applied'; asserted exactly, so a
   *  regression that silently starts dropping CREATE TRIGGER fails here */
  readonly expectNotApplied?: readonly string[];
}

export interface QueryFixture {
  readonly name: string;
  readonly query: string;
  readonly expect: {
    readonly touchedEntityNames: readonly string[];
    readonly unknownIdentifiers: readonly string[];
    readonly parsed: boolean;
  };
}

export interface MigrationFixture {
  readonly name: string;
  readonly before: SchemaModel;
  readonly after: SchemaModel;
  readonly expectDestructive: boolean;
  readonly expectLossy: boolean;
}

export interface ConformanceFixtures {
  /** a hand-built model exercising every capability the engine claims to support; the
   *  validator must return zero errors on it */
  readonly referenceModel: SchemaModel;
  readonly roundTrip: readonly RoundTripFixture[];
  readonly queries: readonly QueryFixture[];
  readonly migrations: readonly MigrationFixture[];
  /** values that MUST be rejected by propsSchemas */
  readonly invalidProps: readonly {
    readonly kind: EnginePropsKind;
    readonly subKind: string | null;
    readonly value: unknown;
  }[];
  /** A redacted model exercising every redaction shape doc 04 §10.2 produces: a stub entity, a
   *  visible link into it (both sides' `fieldIds` cleared together), a masked field with its
   *  ordinal renumbered densely, an index or constraint kept as a badge-only shell, and an
   *  object marked `propsRedacted`. Drives the redaction checks. **There is no ordinal gap** —
   *  doc 04 §10.2 rule 3 renumbers densely, because a gap is itself the disclosure. */
  readonly redactedModel: RedactedModel;
  /** Objects whose engineProps carry an expression, paired with the ids that expression
   *  references. Drives `references/superset`. */
  readonly expressionReferences: readonly {
    readonly object: IrObject;
    readonly subKind: string | null;
    readonly expectReferences: readonly IrObjectRef[];
  }[];
  /** path to the package's "/static" entry, for the bundle-size check; omit to skip it */
  readonly staticEntry?: string;
}

export type ConformanceCheckId =
  | 'identity/id-is-slug' | 'identity/version-is-semver'
  | 'capabilities/schema-valid' | 'capabilities/features-total'
  | 'capabilities/internally-consistent'
  | 'terminology/covers-all-kinds'
  | 'types/resolve-format-roundtrip' | 'types/aliases-resolve'
  | 'types/unknown-is-total' | 'types/picker-includes-custom-types'
  | 'props/schemas-are-strict' | 'props/accept-importer-output'
  | 'props/accept-exporter-roundtrip' | 'props/reject-invalid'
  | 'props/rollback-is-read-only'
  | 'links/descriptors-consistent' | 'links/tolerates-redacted'
  | 'references/superset'
  | 'import/accounts-for-every-statement' | 'import/reasons-present'
  | 'import/never-throws' | 'import/deterministic'
  | 'export/deterministic' | 'export/order-independent' | 'export/phases-ordered'
  | 'export/comments-from-docs' | 'export/skips-restricted' | 'export/redaction-is-announced'
  | 'roundtrip/ddl-ir-ddl' | 'roundtrip/idempotent'
  | 'validator/deterministic' | 'validator/sorted'
  | 'validator/clean-on-reference-ir' | 'validator/quickfix-resolves'
  | 'validator/expression-reference-stale'
  | 'migration/empty-diff-no-steps' | 'migration/drops-are-destructive'
  | 'migration/accounts-for-every-change' | 'migration/steps-ordered'
  | 'diff/annotate-is-pure' | 'diff/annotate-never-raises-severity'
  | 'query/fixtures-resolve' | 'query/unknown-has-range' | 'query/never-throws'
  | 'ai/serialize-deterministic' | 'ai/serialize-respects-budget'
  | 'ai/serialize-omits-restricted' | 'ai/serialize-escapes-docs'
  | 'ai/parse-output-tolerant'
  | 'static/bundle-size';

export const CONFORMANCE_CHECKS: readonly ConformanceCheckId[];

export interface ConformanceOptions {
  /** a skip needs a written reason; the harness prints them in the run summary */
  readonly skip?: readonly { readonly id: ConformanceCheckId; readonly reason: string }[];
  readonly maxClientBytes?: number;   // default 50_000, min+gzip
}

/** Registers one vitest `describe` with one `it` per check. */
export function describeEngineConformance(
  definition: EngineDefinition,
  fixtures: ConformanceFixtures,
  options?: ConformanceOptions,
): void;
```

```ts
// packages/engines/postgresql/test/conformance.test.ts — the entire file
import { describeEngineConformance } from '@schemaloom/engine-sdk/conformance';
import { postgresEngine } from '../src';
import { fixtures } from './fixtures';

describeEngineConformance(postgresEngine, fixtures);
```

What the interesting checks actually assert:

- **`roundtrip/ddl-ir-ddl`** — `import(source)` → `export` → `import` again → the two IRs are
  deep-equal after normalising ids (ids come from the seeded `newId`, so they already match) and
  after dropping canvas positions, which export cannot carry. Comparing generated DDL to the
  *original* source would only test formatting; comparing IRs tests meaning.
- **`roundtrip/idempotent`** — exports 2 and 3 are byte-identical.
- **`export/order-independent`** — every array in `referenceModel` is reversed, then exported; the
  output must be byte-identical to the unshuffled export. This is the check that catches an
  exporter accidentally depending on insertion order.
- **`props/accept-exporter-roundtrip`** — export the reference IR, re-import it, and run
  `parseEngineProps` over every object. The engine's own output must satisfy its own schemas.
- **`import/accounts-for-every-statement`** — the four invariants in §9, plus
  `expectNotApplied` matching exactly.
- **`import/never-throws`** — a small deterministic fuzz set: empty string, whitespace, a
  truncated fixture cut at 60% of its length, a fixture with every `;` removed, 4 KB of random
  bytes from a seeded PRNG.
- **`validator/deterministic`** — run three times over the reference IR and over a mutated copy;
  results deep-equal, and `sortDiagnostics(result)` equals `result`.
- **`validator/quickfix-resolves`** — for every diagnostic carrying a quick fix, apply the edit
  to a cloned IR and assert that diagnostic code is gone for that target.
- **`migration/accounts-for-every-change`** — every `DiffEntry` is covered by at least one step
  via `MigrationStep.covers`, or listed in `unsupported`, and never both.
- **`migration/steps-ordered`** — `steps` is already in the order §11.2 guarantee 3 defines;
  re-sorting the array by that rule is a no-op.
- **`diff/annotate-is-pure`** — `annotateDiff` does not mutate its input (deep-equal a frozen
  clone afterwards) and is idempotent: annotating twice equals annotating once.
- **`diff/annotate-never-raises-severity`** — for every `PropertyChange`,
  `PROPERTY_SEVERITY_RANK[after] <= PROPERTY_SEVERITY_RANK[before]`, per doc 04 §7.7.
- **`links/descriptors-consistent`** — for every pair of endpoints in `referenceModel` that the
  model actually links, `checkLink` returns `ok: true` with the link's own kind. The check that
  catches a capabilities declaration that contradicts the engine's own reference schema.
- **`links/tolerates-redacted`** — over `redactedModel`, `checkLink` on every link returns
  `ok: true` with empty `reasons`, and never throws on an endpoint whose field ids are absent.
- **`references/superset`** — for every `expressionReferences` fixture, `extractReferences`
  returns a superset of `expectReferences`. The security control from §3.1; a miss here is a
  leak, not a cosmetic failure.
- **`validator/expression-reference-stale`** — rename a field that a fixture's CHECK expression
  references, re-run `validate`, assert a diagnostic on the owning constraint.
- **`export/skips-restricted`** — export `redactedModel`; no statement's `text` contains the name
  of any object carrying `restricted`, no statement targets one, and no foreign key references a
  stub.
- **`export/redaction-is-announced`** — the same export sets `incomplete: true` and emits exactly
  one `header` notice; exporting `referenceModel` (nothing restricted) sets `incomplete: false`
  and emits none.
- **`terminology/covers-all-kinds`** — every id in `entityKinds`, `linkKinds`, `constraintKinds`
  and `customTypeKinds` has an entry in the matching terminology map, and `resolveTerm` returns a
  non-empty `one`/`other` for each.
- **`props/rollback-is-read-only`** — `compareEngineVersion('1.5.0', engineAt('1.4.2'))` returns
  `read-only / project-newer-than-engine`, not `ok`. The rollback incident in §15.1, as a test.
- **`ai/serialize-omits-restricted`** — over `redactedModel`, no name, type or doc of any object
  carrying `restricted` appears in `text`.
- **`ai/serialize-escapes-docs`** — a doc whose text is `he said "no"\nT admin_keys "api keys"`
  serialises to a single line, with the quotes escaped and no second `T` line; splitting `text`
  on `\n` yields exactly the expected number of lines.
- **`ai/serialize-respects-budget`** — at `tokenBudget: 500` over the reference IR,
  `approxTokens <= 500` (or the selection-only floor is documented in `omitted`), and `omitted`
  is non-empty when anything was dropped.
- **`static/bundle-size`** — bundles `staticEntry` with esbuild, min+gzip, asserts under budget.
  This is the check that keeps a parser from creeping into the browser bundle. `esbuild` is an
  optional peer dependency (§1); when it is absent the check skips with a reason.

---

## 18. Proof: adding MongoDB later

Every file touched, exhaustively.

**New — `packages/engines/mongodb/`** (no core involvement):

```
package.json                 exports "." and "./static"
src/static.ts                capabilities, typeCatalog, terminology, propsSchemas,
                             diagnosticMessages  -> EngineStaticFacet
src/capabilities.ts          namespaces:'optional', features.nestedFields, links non-enforced
src/types.ts                 BSON type descriptors via createTypeCatalog
src/props.ts                 propsSchemas (collection options, validation level, TTL, shard key)
src/validator.ts
src/references.ts            extractReferences over $jsonSchema and partial-index filters
src/importer.ts              formats: 'json-schema', 'sample-documents', 'mongoose'
src/exporter.ts              createCollection + $jsonSchema validator + createIndex
src/migration.ts             collMod / createIndex / dropIndex plans
src/query-validator.ts       aggregation pipeline parser
src/ai-profile.ts            SCS serialiser variant + pipeline output instructions
src/index.ts                 the full EngineDefinition
test/fixtures.ts
test/conformance.test.ts     describeEngineConformance(mongodbEngine, fixtures)
```

**New — `packages/engines/mongodb-ui/`:**

```
package.json
src/index.ts                 default export: EngineUiPlugin
src/nodes/collection-node.tsx    nested field tree renderer
src/panels/collection.tsx
src/panels/field.tsx             nested path, BSON type, array-of
src/panels/index.tsx
src/type-picker.tsx
src/editor-language.ts           CodeMirror javascript mode for pipelines
```

**Touched in the apps — four lines total:**

| file | change |
| --- | --- |
| `apps/api/package.json` | one dependency line |
| `apps/api/src/engines/engines.manifest.ts` | one entry: `mongodbEngine` (`engines.module.ts` is untouched — it names no engine) |
| `apps/web/package.json` | two dependency lines (`engine-mongodb` for `/static`, `engine-mongodb-ui`) |
| `apps/web/src/engines/register.ts` | `engineFacets.register('mongodb', () => import('@schemaloom/engine-mongodb/static'));` and `engineUi.register('mongodb', () => import('@schemaloom/engine-mongodb-ui'));` |

**Optional cleanup:** delete the `mongodb` row from `apps/api/src/engines/coming-soon.const.ts`.
Not required — a registration already wins over an announcement, so leaving the row changes
nothing.

**Not touched, and this is the claim being made:**

- `apps/api/src/{schema,import,export,ai,access,snapshots,realtime,projects}/**`
- `apps/web/src/{canvas,inspector,docs,ai,sharing,palette}/**`
- `packages/schema-model/**`, `packages/contracts/**`, `packages/ui/**`
- `prisma/schema.prisma` and **no database migration**: nesting already exists
  (`fields.parent_field_id`), and everything MongoDB-specific lands in `engineProps` (C4).

The features that would normally force a core change, and where they land instead:

| MongoDB reality | absorbed by |
| --- | --- |
| databases are optional, not designed up front | `namespaces: 'optional'` + `supportsNamespaces(caps)` gating |
| no foreign keys; references are conventions | `LinkKindDescriptor.enforced: false` — core hides referential actions generically |
| nested and array fields | `features.nestedFields`, `maxFieldDepth`, existing `parentFieldId` |
| collections are schemaless | `EntityKindDescriptor.fieldsAreAuthoritative: false` |
| "Collection / Field / Reference", "Add collection" | `TerminologyBundle` |
| aggregation pipelines, not SQL | `capabilities.queryLanguage` + `loadEditorLanguage()` |
| `$jsonSchema` instead of DDL | `import/exportFormats` descriptors |
| no `COMMENT ON` | `features.comments: false` — export dialog drops the checkbox |

---

## Key decisions

1. **`EngineDefinition` is split into `EngineStaticFacet` (isomorphic) and the full
   server-side definition, and `propsSchemas` is on the static half.** The PostgreSQL parser is
   megabytes of WASM; the browser needs capabilities, types, nouns and the zod schemas its forms
   validate against. One object on the server, a `/static` entry for the browser, a bundle-size
   check to keep them honest. The browser reaches the facet through
   `createEngineFacetRegistry()` (§16.0), keyed on `project.engineId` exactly like the UI
   registry, and the imported facet — not the `GET /engines` payload — is authoritative on the
   client.
2. **Capabilities are pure JSON with a total boolean record that defaults to `false`, and an
   atom exists only when no descriptor already answers the question.** Totality means core never
   branches on `undefined`; deny-by-default means a new SDK feature never auto-enables for an
   untested engine; and cutting the list from 33 atoms to 10 removed fourteen places where an
   engine could contradict its own descriptors with nothing to catch it. Every surviving atom
   names the core surface that reads it, and `defineCapabilities` enforces fifteen written
   invariants.
3. **Link legality is declarative data evaluated by one shared `checkLink`.** The canvas needs a
   synchronous answer mid-drag and the server needs the same answer on write; a function on the
   definition would have forced either a server round-trip per drag frame or two copies of the
   rules.
4. **Terminology lives on the client facet, not the UI plugin** (a deliberate deviation from the
   brief). Nouns are strings, not React, and putting them there means an engine with no UI
   package still says "Add collection" instead of "Add entity".
5. **Core owns the message catalog; engines own only nouns.** Engines cannot drift the product's
   voice, translation later has one catalog to translate, and a grep test fails the build the
   moment someone types a literal "Add table".
6. **`engineProps` schemas are `.strict()` and resolved per sub-kind.** Junk in JSONB is
   unrecoverable later, and tables and views genuinely have different props.
7. **Props validation blocks a write; validator errors do not.** A props failure means a
   structurally wrong row. A validator error means a design that is temporarily invalid, which is
   a normal state halfway through an edit.
8. **Importer and migration generator must account for every input.** Statement-level reports
   with a mandatory reason for anything not applied, and an `unsupported` list on the migration
   plan. Silent dropping is the failure mode that destroys trust in an import tool.
9. **The exporter has a written total ordering** (phase, dependency, then byte-order tie-break)
   and is tested for determinism and input-order independence, so an export diff is a schema
   diff.
10. **Quick fixes are a five-case serialisable edit union carrying `targetVersion`, not a patch
    language.** They travel as JSON, are applied through the normal update endpoint (a path op
    by read-modify-write of the whole `engineProps`), and a stale one 409s cleanly instead of
    clobbering. `deleteObject` routes to the delete endpoint with its own permission check, and
    the type forbids a project-targeted fix.
11. **`restrictedProbe` stays optional and core never supplies one.** The "it leaks no more than
    the canvas" claim was false — the canvas stubs only entities linked to something visible,
    while the probe answered for any name typed. Bounding it to stubs would make the claim true
    but costs a rate limit and an audit rule to buy a friendlier error string; doc 05's
    unqualified 404/403 rule (and its property test) is worth more. An unresolvable identifier is
    `unknown`, indistinguishable from a typo.
12. **The AI context format is a line-oriented pseudo-DDL (SCS), not JSON, with one production
    per line and a written escaping rule.** Roughly 3–4× fewer tokens, in-distribution for the
    model, trimmable by deleting lines, and deterministic so it is prompt-cacheable. Doc text is
    untrusted user input written by anyone with `docs:edit` and read by a more privileged user,
    so it is collapsed, escaped and truncated before it reaches a quoted slot — without that, a
    documenter can inject forged schema into the model's context.
13. **Nothing carrying `restricted` reaches the AI, at any level.** The serialiser omits it and
    everything that would name it, as its own invariant rather than as a caller's obligation, and
    a conformance check asserts it. Spec §5 is most emphatic here and the signature must not be
    the weak point.
14. **AI output uses XML-ish tagged blocks, and the SDK ships the incremental parser.** The
    response is streamed over SSE; a partial JSON string cannot be rendered, a partial `<query>`
    block can — but only if something can consume one, so `createTaggedBlockStream()` is core-
    owned and shared, and the engine contributes only per-mode instructions. `parseOutput` is
    mode-aware and its result is a union, so `draft-docs` and `draft-schema` have real output
    contracts instead of being modes with nowhere to land.
15. **`suggestJoinPaths` is optional with a shared BFS default.** No engine should write a second
    graph search.
16. **"Coming soon" engines are data rows in `apps/api`, with no registration; registration
    always wins.** Status is a property of the deployment, not of the engine, so
    `EngineDefinition` has no `status` field and shipping an engine needs no edit to the
    announcement list. The picker is registry-driven end to end.
17. **Engine version drift produces read-only verdicts and nothing else — no migration
    machinery, and semver is compared in full.** The upgrade-on-open transaction was a
    project-wide write on a read path with no lock, no actor and a rollback that discarded its
    own failure flag; deleting it removed four failure modes for a breaking change that does not
    exist yet. Comparing the whole version rather than the major closes the `.strict()` rollback
    incident, which is the drift that will actually happen. Snapshots carry their own
    `enginePluginVersion` and a cross-major restore or diff is refused rather than mangled.
18. **A missing or broken UI plugin degrades to `FALLBACK_ENGINE_UI` rather than failing.** Since
    nouns, capabilities, types and props schemas come from the client facet, a backend-only
    engine is genuinely usable, which is what makes the "no core changes" claim true in practice.
19. **A type label is rendered on demand, never stored.** `TypeRef` carries `name` / `args` /
    `dimensions` / `customTypeId` and nothing else; `format(resolve(ref, ctx))` renders, and
    `buildRef` is the only writer of a canonical ref. Doc 04 deleted the denormalised
    `display` because a value both the client and the server compute is a value that drifts
    (`varchar(255)` versus `character varying(255)`), after which search and docs mode
    disagree about identical types. Consequences kept: `TypePickerProps` traffics in
    `TypeRef`, not strings, and `ResolvedType.args` admits strings so a non-numeric type
    parameter is not silently dropped.
20. **`annotateDiff` returns a branded `AnnotatedDiff` that the migration generator requires.**
    A comment saying "already annotated" is not a guardrail on a path whose failure mode is
    running an uncommented `DROP COLUMN` against production. The brand also carries entry-level
    risk, so a `removed` entry can be destructive at all — doc 04's `PropertyChange` array exists
    only on `changed` entries.
21. **The exporter takes no doc map, and a redacted export is announced rather than faked.**
    Documentation is already flattened onto `IrBase.doc` and redaction onto `IrBase.restricted`.
    A masked field is *skipped* in DDL rather than emitted by name and type, because doc 04 blanks
    the `engineProps` that held its default and `salary numeric NOT NULL` without `DEFAULT 0` is a
    script that corrupts or fails on the customer's machine. One un-quantified header notice, no
    counts — a count of what you cannot see is the leak doc 05 §8.4 L8 forbids.
22. **Diagnostics carry `code` + `params`, never prose, and are rendered per recipient after
    redaction.** The validator runs on the unredacted model and its output is cached per project
    and broadcast to every socket; a pre-rendered sentence cannot be filtered, so
    `"orders.employee_id (uuid) is not compatible with salaries.id (bigint)"` on a link the
    analyst can see would hand them a hidden table's name and PK type.
23. **`extractReferences` is a required method, and it is what makes doc 05's expression
    redaction implementable.** CHECK bodies, partial-index predicates, defaults and generated
    expressions all live in `engineProps`, which C4 forbids core from reading; only the engine can
    say which objects they touch. It fails closed — an engine returning `[]` gets every
    expression-bearing prop dropped for subjects lacking `field:viewRestricted` — and it is also
    the only way to notice that a rename left an expression dangling.
24. **Whole-model validation runs in the existing BullMQ worker; only scoped write validation is
    inline.** The spec's 300+ entities is 10–20k IR objects, not "hundreds of rows", and a
    synchronous pass over that from the project-health meter stalls every other request on a
    single-threaded instance.

## Open questions

### Cross-document dependencies this revision creates

These are not opinions; they are columns and lines other documents must add for the contracts
above to be implementable. Each is one line.

1. **Doc 02 — `Project.enginePluginVersion String @map("engine_plugin_version")`.** The engine
   *plugin* contract version needs a home separate from `engineVersion` (the target database
   version, `"16"`). It is a real column rather than a key in `settings` because `settings` is
   already core-owned and validated by core's `projectSettingsSchema`, and three owners in one
   JSON blob lose each other's writes. §15.
2. **Doc 02 — `Project.schemaRevision BigInt @default(0)`**, incremented in the same transaction
   as every schema-object write and delete. It is the diagnostics cache key. `max(object.version)`
   is not monotonic under delete and does not change when a non-maximal object is edited, so it
   served stale and resurrected diagnostics. §8.1.
3. **Doc 02 — `Snapshot.enginePluginVersion String`**, stamped on write beside `irSchemaVersion`.
   Without it a cross-major restore writes rows no subsequent edit can save. §15.2.
4. **Doc 02 — one `refs Json` column per `engine_props`-bearing table**, populated from
   `extractReferences` on every write and surfacing on the IR as `IrBase.refs?: ObjectRefs`
   (`{ entityIds, fieldIds }`). Doc 02 Key decision 23 rejected the three narrow arrays an
   earlier draft here asked for — `constraints.referenced_field_ids`,
   `index_columns.referenced_field_ids`, `fields.default_referenced_ids` — because they still
   missed `CREATE INDEX ON employees ((salary * 12))`, which names no field id at all; doc 05
   Key decision 12 chose the same single column independently. Doc 05 §8.4 L3–L6 already
   assumes it exists; §3.1 here is the contract that produces it.
5. **Doc 04 — `summary.destructive` undercounts.** It is defined as "entries with at least one
   destructive `PropertyChange`", and `added`/`removed` entries have no `properties` array, so a
   DROP TABLE contributes zero. This document works around it with `AnnotatedDiff.entryRisk`
   (§11.1), which needs no change to doc 04's types — but the cleaner fix is `destructive?:
   boolean` on `DiffEntryBase` and an entry-level summary. Doc 04's call; if it makes the change,
   `entryRisk` collapses to the brand alone.
6. **Doc 05 — the diagnostics stream is a channel its leak table does not cover.** L1–L10 have no
   row for it, and this document invented it. §2.4's structured form plus per-recipient rendering
   is the mitigation; doc 05 should add the row so the control has a documented owner.
7. **Doc 05 §8 vs docs 03/04 — one IR type, two branded aliases, settled here.** Doc 05 types
   redaction as `redact(raw: RawSchemaIR): RedactedIR` with a separate `IRPatch`; docs 03 and 04
   have one `SchemaModel` with a `redacted` flag, and doc 04's Key decision 20 depends on that.
   The resolution in §2.1: keep the single type, express doc 05's distinction as
   `type RedactedModel = SchemaModel & { redacted: true }`, and have every engine surface whose
   output reaches a user take `RedactedModel`. Doc 05 keeps its compile-time guarantee, doc 04
   keeps one renderer. (Doc 02 §7's sketch `engine.propsSchemas.field.parse(...)` is also stale —
   `propsSchemas.field` is an `EnginePropsResolver` taking a sub-kind, not a schema.)
8. **Doc 05 §8.4 L22 vs doc 04 §10.1 — ordinal gaps.** Doc 05 densely renumbers ordinals in the
   redacted model; doc 04 keeps the originals and says the validator must tolerate gaps. §8.3
   here makes the conflict harmless for engines (the validator never sees a redacted model), but
   the two documents still disagree about what `VisibilityFilter` emits, and the canvas cares.
   Doc 05's position looks right to me — a gap *is* the leak — but it is their call to make.

### Judgement calls that need a decision

9. **Type names are verified against doc 04 as written today.** If doc 04 moves after review,
   `packages/engine-sdk/src/ir.ts` is the entire integration diff.
10. **Engine DTOs live in `engine-sdk`, not `contracts`.** C10 declares `contracts -> schema-model`
    and not `contracts -> engine-sdk`, so `EngineDescriptor`, `EngineCatalog` and
    `engineCapabilitiesSchema` are exported from `engine-sdk` and imported by both apps. If every
    wire type should live in `contracts`, add the edge (still acyclic) and re-export.
11. **Terminology placement deviates from the brief**, which listed it under the UI plugin. The
    reasoning is Key decision 4. It can move, at the cost of wrong nouns in the fallback UI.
12. **Still over-built, flagged rather than cut:** `'wide-column'` in `EngineParadigm` with no
    planned engine, and `paradigm` itself, which appears only in the picker card and the AI system
    prompt — the spec asks for it, so it stays, but it must never become a switch target. Cut in
    this revision, and restorable additively if any of it was wanted: `Introspector` and
    `features.introspection`; `EntityKindDescriptor.userCreatable`; `TypeDescriptor.since`,
    `ExportFormatDescriptor.targetVersions` and both `targetVersion` options; `propsMigrations`
    and the upgrade transaction; `hasFeature`, `EngineUiRegistry.peek`,
    `TerminologyBundle.overrides`, `ImportFormatDescriptor.mimeTypes`, `AiOutputFormat.kind`,
    `'generic-brackets'`, `AiPromptContext.capabilities`, and 23 of the 33 feature atoms.
13. **Quick-fix edit union is deliberately narrow** (five ops). "Add the missing index", "create
    the referenced entity" are not expressible. Extending it later is additive.
14. **`approxTokens` is a character-count heuristic**, not a tokeniser. Good enough for trimming;
    if AI usage billing needs exact numbers, core calls the Anthropic token-counting endpoint and
    the field becomes advisory.
15. **Engine `version` is the behaviour contract, not the npm version.** Two version numbers on
    one package invites confusion; the alternative is deriving it from `package.json` and
    requiring lockstep. I prefer the explicit field; confirm.
16. **Max source size for imports** is per-format (`ImportFormatDescriptor.maxBytes`). No number
    picked; PostgreSQL DDL dumps of 50 MB exist. Suggest 5 MB synchronous, larger via the BullMQ
    import job, decided in the import/export document — which also owns the four merge questions
    named in §9.2.
17. **The first real engine major bump has no migration path by design** (§15.1): the project
    opens read-only until an operator runs a job that does not exist yet. That is correct for a
    v1 with one engine at major 1, and it is a commitment to write that job before the first
    breaking change ships rather than after. Worth an explicit yes.
