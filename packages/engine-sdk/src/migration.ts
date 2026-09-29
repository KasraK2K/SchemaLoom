import type { Diagnostic, DiagnosticParam, EngineContext, EngineId } from './diagnostics.js';
import type { DiffEntry, IrObjectRef, PropertySeverity, SchemaDiff, SchemaModel } from './ir.js';

/**
 * Doc 03 §11 — the migration contract.
 *
 * Everything here runs server-side over the TRUE model (§2.1): `annotateDiff` and
 * `migrationGenerator.generate` take `SchemaModel`, not `RedactedModel`. The API's migration
 * routes require the full view (R21′) for the same reason restore does — a script generated
 * from a partial view silently omits the objects the caller cannot see.
 */

/**
 * §2.1 — "downward" in "annotateDiff may refine severity downward, never upward" needs an
 * order, or `diff/annotate-never-raises-severity` cannot be written. TOTAL over doc 04's four
 * severities.
 *
 * `governance` outranks everything an engine may touch, and the second half of the rule
 * covers it: **`annotateDiff` may neither assign nor remove `governance`.** Core alone decides
 * that a change affects who can see an object (doc 04 §7.4). The conformance check asserts
 * both halves.
 */
export const PROPERTY_SEVERITY_RANK: Readonly<Record<PropertySeverity, number>> = {
  governance: 3,
  structural: 2,
  documentation: 1,
  cosmetic: 0,
};

/** Risk for one entry as a whole — the only home an `added` / `removed` entry has. */
export interface EntryRisk {
  readonly destructive: boolean;
  readonly note?: string;
}

/**
 * §11.1 — produced only by `engine.annotateDiff`, required by the migration generator. An
 * unannotated diff does not typecheck into a migration: a caller that builds a plan from
 * `diffModels(before, after)` directly would otherwise get a diff where every `destructive`
 * is `undefined`, so `commentedOut` is `false` even with `allowDestructive: false`.
 */
export type AnnotatedDiff = SchemaDiff & {
  readonly annotatedBy: EngineId;
  /** Risk at ENTRY level, keyed by `entryRiskKey` (`${objectType}:${id}`). doc 04's
   *  `PropertyChange` array exists only on `changed` entries, so a DROP TABLE — which
   *  contributes zero destructive PropertyChanges — had nowhere to carry its risk. */
  readonly entryRisk: Readonly<Record<string, EntryRisk>>;
};

/** The `entryRisk` key for an entry. Written once so the engine and core cannot disagree
 *  about the spelling. */
export function entryRiskKey(entry: Pick<DiffEntry, 'objectType' | 'id'>): string {
  return `${entry.objectType}:${entry.id}`;
}

/**
 * The rule core and the generator both read:
 *  - `changed` entries: `PropertyChange.destructive` per property, plus `entryRisk` for the
 *    entry as a whole;
 *  - `added` / `removed` entries: `entryRisk` only.
 * `annotateDiff` must populate `entryRisk` for every `removed` entry of a namespace, entity,
 * field or custom type with `destructive: true` — core's pre-set (doc 04 §7.7).
 */
export function entryIsDestructive(diff: AnnotatedDiff, entry: DiffEntry): boolean {
  if (diff.entryRisk[entryRiskKey(entry)]?.destructive === true) return true;
  return entry.change === 'changed' && entry.properties.some((p) => p.destructive === true);
}

/** The four object types whose removal core pre-sets as destructive (doc 04 §7.7). */
export const DESTRUCTIVE_REMOVALS: ReadonlySet<DiffEntry['objectType']> = new Set([
  'namespace',
  'entity',
  'field',
  'customType',
]);

/**
 * Which entries §11.2 guarantee 2 ("covered by a step or listed in `unsupported`") applies to.
 * Doc 04 says the generator ALWAYS skips `governance` and ignores `cosmetic`, and an area is a
 * canvas grouping no engine has DDL for — so an entry with nothing structural in it needs no
 * step, and listing it as "needs a manual step" would be a false alarm. `documentation`-only
 * changes are the engine's choice (a COMMENT ON, or nothing) and are not demanded either.
 */
export function needsMigrationStep(entry: DiffEntry): boolean {
  if (entry.objectType === 'area') return false;
  return entry.change !== 'changed' || entry.properties.some((p) => p.severity === 'structural');
}

/**
 * §11.2 — migrations get their own phase vocabulary rather than borrowing the exporter's.
 * There is no correct export phase for `ALTER TABLE ADD COLUMN`, and an ordering guarantee
 * that depends on an arbitrary choice is not a guarantee.
 */
export const MIGRATION_PHASE_ORDER = ['pre', 'drops', 'alters', 'creates', 'post'] as const;
export type MigrationPhase = (typeof MIGRATION_PHASE_ORDER)[number];

/** §11.2 guarantee 3's within-phase order: drop before rename before create before alter. */
export const MIGRATION_OPERATION_ORDER = ['drop', 'rename', 'create', 'alter'] as const;
export type MigrationOperation = (typeof MIGRATION_OPERATION_ORDER)[number];

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
  /** the machine-readable shape of the step, which is what the ordering rule sorts on.
   *  `kind` stays as free text for display. */
  readonly operation: MigrationOperation;
  /** 'ALTER TABLE ADD COLUMN' */
  readonly kind: string;
  /** no trailing separator, no trailing newline — like `ExportStatement.text` */
  readonly text: string;
  /** irreversibly removes an object or its data */
  readonly destructive: boolean;
  /** existing values may be changed or truncated (varchar(50) -> varchar(20), int8 -> int4) */
  readonly lossy: boolean;
  /** takes a long lock / rewrites the table — the downtime warning */
  readonly requiresTableRewrite: boolean;
  /** REQUIRED whenever destructive || lossy || requiresTableRewrite. Structured like a
   *  Diagnostic (§2.3) and rendered by the same path. */
  readonly reasonCode: string | null;
  readonly reasonParams: Readonly<Record<string, DiagnosticParam>>;
  /** Every DiffEntry this step accounts for — NON-EMPTY. One `changed` field entry with two
   *  PropertyChanges may need two steps; one `ADD COLUMN … REFERENCES` covers two entries. */
  readonly covers: readonly IrObjectRef[];
  /** true when destructive && !options.allowDestructive */
  readonly commentedOut: boolean;
}

export interface UnsupportedChange {
  readonly entry: IrObjectRef;
  /** rendered like a Diagnostic */
  readonly changeCode: string;
  readonly changeParams: Readonly<Record<string, DiagnosticParam>>;
  readonly reasonCode: string;
  readonly reasonParams: Readonly<Record<string, DiagnosticParam>>;
}

export interface MigrationPlan {
  readonly steps: readonly MigrationStep[];
  readonly summary: {
    readonly total: number;
    readonly destructive: number;
    readonly lossy: number;
    readonly rewrites: number;
  };
  /** diff entries the generator could not express as a step. Never silently drop an input;
   *  the UI shows these as "2 changes need a manual step". */
  readonly unsupported: readonly UnsupportedChange[];
  readonly diagnostics: readonly Diagnostic[];
  /**
   * ADDITION to §11.2: how `options.transactional` reaches the script. A step must cover at
   * least one DiffEntry, so `BEGIN` cannot be a step, and core cannot spell `BEGIN` without
   * naming an engine's syntax. null = not requested, or the engine has no transactional DDL.
   */
  readonly transaction: { readonly begin: string; readonly commit: string } | null;
}

export interface MigrationGenerator {
  generate(input: MigrationInput): Promise<MigrationPlan>;
}

/** §11.2 guarantee 3, the part a caller can check from the step alone: phase, then
 *  operation. Dependency order and the name tie-break are the engine's and live inside it. */
export function compareMigrationSteps(
  a: Pick<MigrationStep, 'phase' | 'operation'>,
  b: Pick<MigrationStep, 'phase' | 'operation'>,
): number {
  return (
    MIGRATION_PHASE_ORDER.indexOf(a.phase) - MIGRATION_PHASE_ORDER.indexOf(b.phase) ||
    MIGRATION_OPERATION_ORDER.indexOf(a.operation) - MIGRATION_OPERATION_ORDER.indexOf(b.operation)
  );
}

export interface RenderMigrationOptions {
  /** the engine's `capabilities.queryLanguage.statementSeparator` */
  readonly separator: string | null;
  /** the engine's `capabilities.queryLanguage.lineComment` */
  readonly lineComment: string | null;
}

/**
 * The plan as one script. A commented-out step keeps its text, every line behind the line
 * comment, so the file is complete and running it as-is executes nothing destructive.
 */
export function renderMigrationScript(
  plan: MigrationPlan,
  options: RenderMigrationOptions,
): string {
  const separator = options.separator ?? '';
  const comment = options.lineComment ?? '--';
  const lines: string[] = [];
  if (plan.transaction !== null && plan.steps.length > 0)
    lines.push(plan.transaction.begin + separator, '');
  for (const step of plan.steps) {
    const text = step.text + separator;
    if (!step.commentedOut) {
      lines.push(text);
      continue;
    }
    lines.push(`${comment} DESTRUCTIVE — remove the comment markers to run:`);
    for (const line of text.split('\n')) lines.push(`${comment} ${line}`);
  }
  if (plan.transaction !== null && plan.steps.length > 0)
    lines.push('', plan.transaction.commit + separator);
  return lines.join('\n');
}
