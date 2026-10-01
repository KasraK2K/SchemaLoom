import type {
  Diagnostic,
  ImportContext,
  ImportOptions,
  ImportReport,
  ImportResult,
  ImportStatementReport,
  ImportStatementStatus,
  Importer,
  IrObjectRef,
  IrObjectType,
  SchemaModel,
} from '@schemaloom/engine-sdk';
import { CAPABILITIES } from './capabilities.js';
import { ImportModel } from './import-model.js';
import { statementsOf } from './import-ast.js';
import { seatReferences } from './import-refs.js';
import {
  classify,
  declareStatement,
  dependentStatement,
  type StatementClass,
  type StatementContext,
} from './import-statements.js';
import { CODE } from './messages.js';
import { truncateToBytes, utf8ByteLength } from './normalize-name.js';
import { loadSqlParser } from './parser.js';
import { foldSerialColumns } from './import-serial.js';
import { excerptOf, rangeOf, splitStatements, type SourceChunk } from './sql-scan.js';

/**
 * Doc 03 §9 — the PostgreSQL importer.
 *
 * THE LOAD-BEARING RULE: an importer accounts for EVERY statement in the source. It may
 * refuse one, but it may never be silent about one. Everything in this file exists so that
 * `report.statementCount - report.countsByStatus.applied` is a number the preview dialog can
 * put in a sentence, with an excerpt, a reason and a source range behind each entry (§9.1).
 *
 * WHY THE SOURCE IS SPLIT BEFORE IT IS PARSED, rather than handed whole to `libpg-query`:
 * the real parser refuses a FILE when one statement in it is malformed. That would turn a
 * 200-statement migration with one typo into a single `failed` entry saying nothing useful.
 * Splitting first — with a lexer, not a parser — makes that one typo ONE failed statement in
 * a report where the other 199 are applied, which is §9's invariant 4 taken seriously rather
 * than satisfied minimally.
 *
 * WHAT THIS FILE DOES NOT DO: decide the merge. §9.2 is explicit that collision keys, doc
 * retention, position retention and retargeting are core's, not the engine's. The result is a
 * standalone IR plus a report; applying it to a project is the API's job.
 */

const FORMAT = CAPABILITIES.importFormats[0];

interface ParsedStatement {
  readonly chunk: SourceChunk;
  readonly statement: unknown;
  readonly classification: StatementClass;
  readonly parseError: string | null;
}

/** Per-statement bookkeeping. Mutable on purpose: both passes write to the same entry, which
 *  is what keeps one statement to one report row. */
interface StatementState {
  readonly parsed: ParsedStatement;
  readonly produced: IrObjectRef[];
  readonly losses: string[];
  failure: string | null;
  /** pass 3 folded this statement into a serial column (`import-serial.ts`) */
  absorbed: boolean;
}

function parseErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message;
  return 'the statement could not be parsed';
}

/** The source, cut to the format's byte ceiling. Cutting on a code-point boundary keeps the
 *  remainder valid UTF-8, so the lexer sees text rather than a broken sequence. */
function applyByteLimit(source: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8ByteLength(source) <= maxBytes) return { text: source, truncated: false };
  return { text: truncateToBytes(source, maxBytes), truncated: true };
}

function emptyCounts(): Record<ImportStatementStatus, number> {
  return { applied: 0, partial: 0, unsupported: 0, ignored: 0, failed: 0 };
}

function statusOf(state: StatementState): { status: ImportStatementStatus; reason: string | null } {
  const { classification, parseError } = state.parsed;
  if (parseError !== null) return { status: 'failed', reason: parseError };
  if (state.failure !== null) return { status: 'failed', reason: state.failure };
  if (state.absorbed) return { status: 'applied', reason: null };
  if (classification.phase === 'ignored') {
    return { status: 'ignored', reason: classification.reason ?? 'not part of the schema model' };
  }
  if (classification.phase === 'unsupported') {
    return {
      status: 'unsupported',
      reason: classification.reason ?? 'not part of the schema model',
    };
  }
  if (state.losses.length > 0) return { status: 'partial', reason: state.losses.join('; ') };
  return { status: 'applied', reason: null };
}

function countObjects(model: SchemaModel): Partial<Record<IrObjectType, number>> {
  const counts: Partial<Record<IrObjectType, number>> = {};
  for (const [type, bag] of Object.entries(model.objects)) {
    const size = Object.keys(bag).length;
    if (size > 0) counts[type as IrObjectType] = size;
  }
  return counts;
}

async function importDdl(
  source: string,
  options: ImportOptions,
  ctx: ImportContext,
): Promise<ImportResult> {
  const diagnostics: Diagnostic[] = [];
  const descriptor =
    CAPABILITIES.importFormats.find((format) => format.id === options.format) ?? FORMAT;
  const { text, truncated } = applyByteLimit(source, descriptor?.maxBytes ?? source.length);

  const model = new ImportModel(
    ctx.newId,
    options.defaultNamespace ?? CAPABILITIES.defaultNamespaceName ?? '',
  );

  // --- split, then parse each statement on its own ---------------------------------------
  const parser = await loadSqlParser();
  const parsed: ParsedStatement[] = [];

  for (const chunk of splitStatements(text)) {
    try {
      const statements = statementsOf(await parser.parse(chunk.text));
      const statement = statements[0];
      if (statement === undefined) {
        parsed.push({
          chunk,
          statement: undefined,
          classification: { phase: 'unsupported', kind: 'unparsed' },
          parseError: 'the statement produced no parse tree',
        });
        continue;
      }
      parsed.push({
        chunk,
        statement,
        classification: classify(statement),
        parseError: null,
      });
    } catch (error) {
      // §9 invariant 4: `import()` never throws on malformed input.
      parsed.push({
        chunk,
        statement: undefined,
        classification: { phase: 'unsupported', kind: 'unparsed' },
        parseError: parseErrorMessage(error),
      });
    }
  }

  const states: StatementState[] = parsed.map((entry) => ({
    parsed: entry,
    produced: [],
    losses: [],
    failure: null,
    absorbed: false,
  }));

  const contextFor = (state: StatementState): StatementContext => ({
    model,
    text: state.parsed.chunk.text,
    loss: (message) => state.losses.push(message),
    fail: (message) => {
      state.failure = message;
    },
    produced: (ref) => state.produced.push(ref),
  });

  // --- pass 1: namespaces, types, entities, fields ---------------------------------------
  for (const state of states) {
    const { phase } = state.parsed.classification;
    if (state.parsed.parseError !== null) continue;
    if (phase === 'declare' || phase === 'both') {
      declareStatement(state.parsed.statement, contextFor(state));
    }
  }

  // --- pass 2: constraints, indexes, foreign keys ----------------------------------------
  for (const state of states) {
    const { phase } = state.parsed.classification;
    // A statement pass 1 refused must not attach its constraints to the FIRST definition.
    if (state.parsed.parseError !== null || state.failure !== null) continue;
    if (phase === 'dependent' || phase === 'both') {
      dependentStatement(state.parsed.statement, contextFor(state));
    }
  }

  // --- pass 3: pg_dump's sequence + OWNED BY + nextval default → a serial column ---------
  const folded = foldSerialColumns(
    states.map((s) => (s.parsed.parseError === null ? s.parsed.statement : undefined)),
    model,
  );
  for (const [index, ref] of folded) {
    const state = states[index];
    if (state === undefined) continue;
    state.absorbed = true;
    if (!state.produced.some((p) => p.id === ref.id)) state.produced.push(ref);
  }

  // --- report ----------------------------------------------------------------------------
  const countsByStatus = emptyCounts();
  const statements: ImportStatementReport[] = states.map((state, ordinal) => {
    const { chunk, classification } = state.parsed;
    const { status, reason } = statusOf(state);
    countsByStatus[status] += 1;

    if (status === 'failed') {
      // §9.1: a diagnostic about the SOURCE rather than about an object targets the project
      // and carries the location. That is the only reason `DiagnosticTarget.type` admits
      // 'project'.
      diagnostics.push({
        code: CODE.importStatementFailed,
        severity: 'error',
        params: { reason: reason ?? '' },
        target: { type: 'project', id: ctx.projectId },
        range: rangeOf(text, chunk.start, chunk.end),
      });
    }

    return {
      ordinal,
      kind: classification.kind,
      range: rangeOf(text, chunk.start, chunk.end),
      excerpt: excerptOf(chunk.text),
      status,
      reason,
      producedObjects: state.produced,
    };
  });

  const built = model.toModel(ctx.projectId, ctx.serverVersion ?? '');
  // §3.1: `refs` is written on import, not only on edit. See `import-refs.ts` for why the
  // export order and R27 redaction both break without it.
  seatReferences(built);

  const report: ImportReport = {
    statementCount: statements.length,
    statements,
    countsByStatus,
    objectCounts: countObjects(built),
    truncated,
  };

  return { model: built, report, diagnostics };
}

export const IMPORTER: Importer = {
  import(source, options, ctx) {
    return importDdl(source, options, ctx);
  },
};

/** The option bag a caller gets when it has no opinion — the file picker's defaults, which
 *  are `capabilities.importFormats[0]` and the engine's own folding rule. */
export function defaultImportOptions(): ImportOptions {
  return {
    format: FORMAT?.id ?? 'ddl',
    defaultNamespace: CAPABILITIES.defaultNamespaceName,
    // `foldsTo: 'none'` is the SDK's spelling of what §9 calls 'preserve'.
    caseFolding:
      CAPABILITIES.identifiers.foldsTo === 'none' ? 'preserve' : CAPABILITIES.identifiers.foldsTo,
    engineOptions: {},
  };
}
