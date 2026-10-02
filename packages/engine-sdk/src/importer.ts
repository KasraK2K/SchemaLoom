import type { Diagnostic, EngineContext, SourceRange } from './diagnostics.js';
import type { Id, IrObjectRef, IrObjectType, SchemaModel } from './ir.js';

/**
 * Doc 03 §9 — the importer contract.
 *
 * The load-bearing rule: **an importer accounts for every statement in the source.** It may
 * refuse a statement, but it may never be silent about it. Everything below exists so the
 * preview dialog can say "3 statements could not be applied", name each one and point at it
 * in the source — without a line of it being PostgreSQL-specific (§9.1).
 */

export interface ImportOptions {
  /** must match an `ImportFormatDescriptor.id` from `capabilities.importFormats` */
  readonly format: string;
  /** namespace for objects the source does not qualify; defaults to
   *  `capabilities.defaultNamespaceName` */
  readonly defaultNamespace: string | null;
  /** sourced from `capabilities.identifiers.foldsTo`, which is already three-valued because
   *  Oracle and DB2 fold up — both are in COMING_SOON */
  readonly caseFolding: 'preserve' | 'lower' | 'upper';
  /** format-specific knobs; validated by the engine, reported as diagnostics */
  readonly engineOptions: Readonly<Record<string, unknown>>;
}

/**
 * Flattened: the previous shape wrapped one field around `EngineContext` and produced
 * `ctx.context.projectId` at every call site.
 */
export type ImportContext = EngineContext & {
  /** id factory. Production passes the **production cuid generator**, so the ids the importer
   *  mints are final; the conformance harness passes a seeded counter so importer output is
   *  byte-comparable across runs. */
  readonly newId: () => Id;
};

export type ImportStatementStatus =
  /** fully represented in the returned IR */
  | 'applied'
  /** represented with loss (`reason` says what was dropped) */
  | 'partial'
  /** understood, deliberately not modelled (CREATE TRIGGER) */
  | 'unsupported'
  /** understood, intentionally irrelevant (SET, BEGIN, COMMENT re-applied later) */
  | 'ignored'
  /** could not be parsed */
  | 'failed';

export const IMPORT_STATEMENT_STATUSES: readonly ImportStatementStatus[] = [
  'applied',
  'partial',
  'unsupported',
  'ignored',
  'failed',
];

export interface ImportStatementReport {
  /** 0-based, contiguous, source order */
  readonly ordinal: number;
  /** engine-native statement label: 'CREATE TABLE', 'CREATE TRIGGER', 'unparsed' */
  readonly kind: string;
  readonly range: SourceRange;
  /** first 200 characters, whitespace-collapsed — what the report list shows */
  readonly excerpt: string;
  readonly status: ImportStatementStatus;
  /** REQUIRED (non-null) whenever `status !== 'applied'`. Plain language, shown verbatim:
   *  'Triggers are not part of the schema model' */
  readonly reason: string | null;
  readonly producedObjects: readonly IrObjectRef[];
}

export interface ImportReport {
  readonly statementCount: number;
  readonly statements: readonly ImportStatementReport[];
  readonly countsByStatus: Readonly<Record<ImportStatementStatus, number>>;
  readonly objectCounts: Readonly<Partial<Record<IrObjectType, number>>>;
  /** true when the source exceeded `ImportFormatDescriptor.maxBytes` and was cut */
  readonly truncated: boolean;
}

export interface ImportResult {
  /**
   * A complete, standalone IR built from the source, with ids from `ctx.newId()`. Core
   * persists the importer's ids UNCHANGED — they are already cuids (C1) produced by the
   * production generator, so there is nothing to rewrite, and `producedObjects` and every
   * diagnostic target therefore stay valid through the merge.
   */
  readonly model: SchemaModel;
  readonly report: ImportReport;
  readonly diagnostics: readonly Diagnostic[];
  /** Comments in the source (PostgreSQL's `COMMENT ON`) on entities and fields of `model`.
   *  Docs are server-owned, so they ride beside the IR rather than in it; core writes them
   *  as docs, additively (a target that already has a doc keeps it). */
  readonly docs?: readonly ImportedDoc[];
}

export interface ImportedDoc {
  /** an entity or field in `ImportResult.model` — the only IR objects that carry docs */
  readonly target: { readonly type: 'entity' | 'field'; readonly id: Id };
  /** plain text, as written in the source */
  readonly text: string;
}

export interface Importer {
  import(source: string, options: ImportOptions, ctx: ImportContext): Promise<ImportResult>;
}
