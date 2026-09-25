import type { Diagnostic, EngineContext } from './diagnostics.js';
import type { IrObjectRef, RedactedModel } from './ir.js';

/**
 * Doc 03 §10 — the exporter contract.
 *
 * Views and materialized views are ENTITIES in the IR (doc 04's `PG_ENTITY_KINDS` is
 * `['table','view','materializedView']`), so they are created in the `entities` phase like
 * any other entity, in dependency order within it. There is no separate `views` phase: with
 * one, a unique index on a materialized view — mandatory for `REFRESH … CONCURRENTLY`, and
 * spec §3.4 requires materialized views — landed in `indexes` *before* the matview existed,
 * producing invalid DDL deterministically.
 */
export const EXPORT_PHASE_ORDER = [
  'header',
  'drops',
  'namespaces',
  'custom-types',
  'entities',
  'constraints',
  'indexes',
  'comments',
  'footer',
] as const;

export type ExportPhase = (typeof EXPORT_PHASE_ORDER)[number];

/** `EXPORT_PHASE_ORDER.indexOf` is O(n) and the exporter's hottest comparator; this is the
 *  same total order as a map lookup. */
export const EXPORT_PHASE_RANK: Readonly<Record<ExportPhase, number>> = Object.fromEntries(
  EXPORT_PHASE_ORDER.map((phase, rank) => [phase, rank]),
) as Record<ExportPhase, number>;

export interface ExportOptions {
  /** an `ExportFormatDescriptor.id` */
  readonly format: string;
  readonly includeComments: boolean;
  readonly includeDrops: boolean;
  readonly includeIfNotExists: boolean;
  readonly engineOptions: Readonly<Record<string, unknown>>;
}

export interface ExportInput {
  /**
   * ALREADY redacted by `VisibilityFilter` — the branded type IS the enforcement (§2.1), so a
   * raw model does not typecheck here. The exporter sees exactly what the requester may see,
   * so exports respect permissions without the engine knowing permissions exist. §10.3 states
   * what the engine must do about it.
   */
  readonly model: RedactedModel;
  readonly options: ExportOptions;
  readonly context: EngineContext;
}

export interface ExportStatement {
  readonly ordinal: number;
  readonly phase: ExportPhase;
  /** 'CREATE TABLE', 'COMMENT ON COLUMN' */
  readonly kind: string;
  /** no trailing separator, no trailing newline */
  readonly text: string;
  readonly target: IrObjectRef | null;
}

export interface ExportResult {
  readonly statements: readonly ExportStatement[];
  /** the engine's own `capabilities.queryLanguage.statementSeparator`, copied here so
   *  `renderStatements` has a path to it from its arguments. */
  readonly separator: string | null;
  /**
   * True when redaction removed or altered anything (§10.3). Core shows "this export is
   * incomplete" in the download dialog. Deliberately a boolean and not a count: doc 05 §8.4
   * L8 requires every aggregate to be computed post-redaction, and "14 objects omitted" is an
   * aggregate over what the user cannot see.
   */
  readonly incomplete: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

export interface Exporter {
  export(input: ExportInput): Promise<ExportResult>;
}

export interface RenderStatementsOptions {
  /** default: `result.separator` */
  readonly separator?: string;
  /** default false; true emits '-- entities' style comments */
  readonly phaseHeadings?: boolean;
  /** default '--'; the engine's `capabilities.queryLanguage.lineComment` */
  readonly lineComment?: string;
}

/** Joins with `result.separator` and a blank line between phases. */
export function renderStatements(
  result: ExportResult,
  options: RenderStatementsOptions = {},
): string {
  const separator = options.separator ?? result.separator ?? '';
  const lineComment = options.lineComment ?? '--';
  const lines: string[] = [];
  let phase: ExportPhase | null = null;

  for (const statement of result.statements) {
    if (statement.phase !== phase) {
      if (phase !== null) lines.push('');
      if (options.phaseHeadings === true) lines.push(`${lineComment} ${statement.phase}`);
      phase = statement.phase;
    }
    lines.push(statement.text + separator);
  }

  return lines.join('\n');
}
