import type { AiProfile } from './ai.js';
import type { EngineCapabilities } from './capabilities.js';
import type { DiagnosticMessages, EngineId } from './diagnostics.js';
import type { Exporter } from './exporter.js';
import type { Importer } from './importer.js';
import type { Introspector } from './introspector.js';
import type { AnnotatedDiff, MigrationGenerator } from './migration.js';
import type { QueryValidator } from './query.js';
import type { IrObject, IrObjectRef, SchemaDiff, SchemaModel } from './ir.js';
import type { EnginePropsSchemas } from './props.js';
import type { ProjectTemplate } from './templates.js';
import type { PropsUpgrade } from './versioning.js';
import type { TerminologyBundle } from './terminology.js';
import type { TypeCatalog } from './type-catalog.js';

export type EngineParadigm = 'relational' | 'document' | 'key-value' | 'wide-column' | 'graph';

/**
 * The half of an engine that is safe and cheap to load in a browser: pure data plus pure
 * functions over that data. No parsers, no Node built-ins, no I/O.
 *
 * `apps/web` and the engine's UI package load only this, from the engine package's `/static`
 * entry. `EngineDefinition extends EngineStaticFacet`, so there is one object at runtime on the
 * server and no duplicated data.
 */
/** Drift — a relation's column names in the database read; undefined when it isn't there. */
export type ViewColumns = (relation: string) => readonly string[] | undefined;

export interface EngineStaticFacet {
  readonly id: EngineId;
  /** 'PostgreSQL' */
  readonly displayName: string;
  /** semver of the engine's BEHAVIOUR contract (§15) — not the target database version */
  readonly version: string;
  readonly paradigm: EngineParadigm;
  /** lucide icon name, e.g. 'database' */
  readonly icon: string;
  /** one line for the engine picker card */
  readonly summary: string;
  readonly capabilities: EngineCapabilities;
  readonly typeCatalog: TypeCatalog;
  readonly terminology: TerminologyBundle;
  readonly diagnosticMessages: DiagnosticMessages;
  /** zod only, no parser — so it loads in the browser, which is where react-hook-form needs it */
  readonly propsSchemas: EnginePropsSchemas;
  /**
   * Fold a name to the spelling the engine treats as the same object — the one engine-supplied
   * function core needs for identity. Pure, total, no I/O.
   *
   * On the FACET and not on `EngineDefinition` (punch-list ∆6) because the canvas's
   * name-collision check runs client-side, in the keystroke that types the name; core's import
   * matcher and the exporter call the same function server-side. Without it `Orders` is
   * inserted next to `orders` and the export emits DDL PostgreSQL rejects.
   */
  normalizeName(s: string): string;
}

/**
 * The server half. Loaded by `apps/api` only.
 *
 * BUILD-ORDER NOTE — step 7 ships `extractReferences` and nothing else. The services below are
 * typed `unknown` because their interfaces land in later steps (`EngineValidator` §8,
 * `Importer` §9, `Exporter` §10, `annotateDiff` §11 — which also needs schema-model's
 * `SchemaDiff`, step 18 — `MigrationGenerator` §12, `QueryValidator` §12, `AiProfile` §13).
 * `unknown` is deliberate rather than a fabricated placeholder interface: PRESENCE is checkable
 * today, which is all `capabilities/services-match-features` needs
 * (`features.migrations === (migrationGenerator !== undefined)`), and nothing can call a member
 * whose contract does not exist yet. Each later step narrows one line here and breaks no
 * caller, because there are none that could have compiled.
 */
export interface EngineDefinition extends EngineStaticFacet {
  /** step 8 — `EngineValidator` */
  readonly validator?: unknown;
  /** step 21 — `Importer` (§9). Narrowed from `unknown` when the contract landed. */
  readonly importer?: Importer;
  /** Phase 6 §1 — reads a live database into import source. Presence must equal
   *  `canIntrospect(capabilities)` (`introspection` is `network` or `file`). */
  readonly introspector?: Introspector;
  /** step 20 — `Exporter` (§10). Narrowed from `unknown` when the contract landed. */
  readonly exporter?: Exporter;
  /** §11.1 — adds risk semantics to a core-produced diff (doc 04 §7.7). Pure and synchronous.
   *  Returns the branded `AnnotatedDiff`, the only thing the migration generator accepts.
   *  Optional so an engine can ship before it has risk knowledge; the migration routes need it. */
  readonly annotateDiff?: (
    diff: SchemaDiff,
    before: SchemaModel,
    after: SchemaModel,
  ) => AnnotatedDiff;
  /** Drift — whether two view bodies are the same query in different spellings (a server
   *  re-prints the body it was given: parentheses, casts, qualification). Engine-specific
   *  and lossy on purpose, so only drift uses it; false whenever either side won't parse.
   *  Absent: drift compares the text. `columns` names a relation's columns in the database
   *  read, so a join's unqualified column can be matched to the table the server qualifies it
   *  with; undefined for a relation it doesn't know. */
  readonly sameViewBody?: (a: string, b: string, columns?: ViewColumns) => Promise<boolean>;
  /** §11.2 — phase-gated; presence must equal `features.migrations` */
  readonly migrationGenerator?: MigrationGenerator;
  /** Phase 2 — `QueryValidator` (§12). Presence must equal `features.queryValidation`. */
  readonly queryValidator?: QueryValidator;
  /** No feature atom: `aiProfile === undefined` simply hides the AI panel and makes the AI
   *  routes 400 `engine.feature-unsupported`. Narrowed from `unknown` with §13 (Phase 5). */
  readonly aiProfile?: AiProfile;
  /**
   * §15.1 / doc 00 Q19 — one entry per past major (`fromMajor` 1 … current − 1), so the api's
   * `engines:upgrade` command can move a project's stored props to this major. Absent at
   * major 1. `props/previous-major-migrates` checks the chain is complete.
   */
  readonly propsUpgrades?: readonly PropsUpgrade[];
  /** Phase 12 — starting schemas offered on the projects page and in the import dialog.
   *  `templates/import-cleanly` imports each one and demands every statement applies. */
  readonly templates?: readonly ProjectTemplate[];

  /**
   * The engine's only obligation to the permission system (§3.1). REQUIRED, pure, synchronous,
   * total: given one IR object, return every IR object its engine-owned expressions reference —
   * a CHECK body, a partial-index predicate, a default, a generated-column expression, an index
   * column's expression. Ids only, never names, never the expression text.
   *
   * THREE RULES MAKE THIS A SECURITY CONTROL RATHER THAN A HINT:
   *
   * 1. SUPERSET, NOT EXACT SET. Returning an id the expression does not really touch costs one
   *    viewer a dropped expression. Missing one is a leak.
   *
   * 2. IT FAILS CLOSED, AND THAT IS THE WHOLE POINT. An engine that cannot analyse its own
   *    expressions returns `[]`. It does NOT thereby opt out of the control — it opts into the
   *    strictest version of it: `VisibilityFilter` sees no evidence that any expression is safe
   *    and DROPS EVERY EXPRESSION-BEARING PROP for any subject lacking `field:viewRestricted`
   *    over the whole entity. An engine returning `[]` from every call therefore ships with its
   *    CHECK bodies, defaults, generated expressions and partial-index predicates blanked for
   *    everyone but a fully-privileged viewer. That is the conservative default a new engine
   *    gets for free on day one, and the reason this member is required rather than optional:
   *    an absent method would have to mean "no expressions to analyse", which is the permissive
   *    reading and the leak.
   *
   * 3. IT IS ALSO THE STALENESS DETECTOR. JSONB has no foreign keys, so renaming
   *    `orders.status` leaves `CHECK (status IN (...))` pointing at a name that no longer
   *    exists. With reference ids persisted, core sees that a rename or delete touched a
   *    referenced id and the validator raises a dangling-reference diagnostic.
   *
   * Called by core on EVERY write of an expression-bearing object and on import; the result is
   * persisted to `refs Json` and surfaces as `IrBase.refs?: ObjectRefs`. An expression the
   * engine cannot parse yields the ids it did recognise, and the engine emits a validator
   * warning so the gap is visible rather than silent.
   */
  extractReferences(
    object: IrObject,
    subKind: string | null,
    model: SchemaModel,
  ): readonly IrObjectRef[];
}
