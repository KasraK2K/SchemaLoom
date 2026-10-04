import type {
  Entity,
  Field,
  Id,
  IdentifierResolution,
  QueryValidationInput,
  QueryValidationResult,
  QueryValidator,
  RedactedModel,
  SourceRange,
} from '@schemaloom/engine-sdk';
import { renderStatements } from '@schemaloom/engine-sdk';
import { buildExport } from './exporter.js';
import { CODE as MESSAGES } from './messages.js';
import { normalizeName } from './normalize-name.js';
import { parseSqlite, type Ast } from './parser.js';
import { openMemory } from './sqlite.js';

const CODE = {
  unknownRelation: MESSAGES.queryUnknownRelation,
  unknownColumn: MESSAGES.queryUnknownColumn,
} as const;

/**
 * Doc 03 §12 for SQLite (Phase 13 §4.5). Parses the query with node-sql-parser's SQLite
 * grammar, then resolves every table and column reference against the caller's REDACTED model,
 * as the MySQL engine does. A stub table and a masked column have blank names and match
 * nothing, so a hidden object reads exactly like a typo (doc 05 P8).
 *
 * When that grammar can't read the query, SQLite itself compiles it against the redacted
 * design's own DDL (`prepare`, never run): SQLite's error is the parse error, and if it
 * compiles, the touched tables are every visible table the text names — a superset, the safe
 * direction for L25.
 *
 * ponytail: one name scope per statement (every table any part of it names), not one per
 * subquery. A column name shared by two tables in different subqueries reads `ambiguous`
 * instead of resolving; per-scope resolution is the upgrade if anyone hits it.
 */

interface Loc {
  readonly start: { readonly offset: number; readonly line: number; readonly column: number };
  readonly end: { readonly offset: number };
}

const isAst = (v: unknown): v is Ast => typeof v === 'object' && v !== null && !Array.isArray(v);

function rangeOf(loc: unknown): SourceRange | null {
  if (!isAst(loc)) return null;
  const l = loc as unknown as Loc;
  return { start: l.start.offset, end: l.end.offset, line: l.start.line, column: l.start.column };
}

/**
 * Where a name sits in the query. The MySQL grammar gives a table its location, the MariaDB
 * one does not, and a column's location can include the space after it; so a location is
 * trimmed to its first token, and a missing one is found by searching the text for the name
 * (backticks allowed), skipping places already claimed.
 */
function locate(
  query: string,
  loc: unknown,
  name: string,
  claimed: Set<number>,
): { text: string; range: SourceRange } | null {
  const at = rangeOf(loc);
  if (at !== null) {
    const raw = query.slice(at.start, at.end);
    const text = raw.trimStart().split(/\s+/)[0] ?? raw;
    const start = at.start + (raw.length - raw.trimStart().length);
    claimed.add(start);
    return { text, range: { ...at, start, end: start + text.length } };
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // SQLite quotes a name with "", `` or [].
  for (const match of query.matchAll(
    new RegExp(`(?<![\\w$])[\`"[]?${escaped}[\`"\\]]?(?![\\w$])`, 'gi'),
  )) {
    const start = match.index;
    if (claimed.has(start)) continue;
    claimed.add(start);
    const before = query.slice(0, start);
    const line = before.split('\n').length;
    const column = start - before.lastIndexOf('\n');
    return { text: match[0], range: { start, end: start + match[0].length, line, column } };
  }
  return null;
}

/** Every node of the AST, depth first. */
function* nodes(value: unknown): Generator<Ast> {
  if (Array.isArray(value)) {
    for (const item of value) yield* nodes(item);
  } else if (isAst(value)) {
    yield value;
    for (const [key, child] of Object.entries(value)) if (key !== 'loc') yield* nodes(child);
  }
}

/** The closest names within two edits, at most three. */
function suggest(name: string, candidates: readonly string[]): string[] {
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i += 1) {
      let prev = row[0] ?? 0;
      row[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const next = row[j] ?? 0;
        row[j] = Math.min(next + 1, (row[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = next;
      }
    }
    return row[b.length] ?? 0;
  };
  const folded = normalizeName(name);
  return [...new Set(candidates)]
    .map((c) => ({ c, d: distance(folded, normalizeName(c)) }))
    .filter(({ d }) => d > 0 && d <= 2)
    .sort((a, b) => a.d - b.d || (a.c < b.c ? -1 : 1))
    .slice(0, 3)
    .map(({ c }) => c);
}

interface Visible {
  readonly entities: ReadonlyMap<string, Entity>;
  readonly fieldsOf: (entityId: Id) => readonly Field[];
}

/** Only what survived redaction with a name: stubs and masked columns are not in here. */
function visibleOf(model: RedactedModel): Visible {
  const entities = new Map<string, Entity>();
  for (const entity of Object.values(model.objects.entity)) {
    if (entity.restricted !== true && entity.name !== '')
      entities.set(normalizeName(entity.name), entity);
  }
  const fields = new Map<Id, Field[]>();
  for (const field of Object.values(model.objects.field)) {
    if (field.restricted === true || field.name === '') continue;
    fields.set(field.entityId, [...(fields.get(field.entityId) ?? []), field]);
  }
  return { entities, fieldsOf: (id) => fields.get(id) ?? [] };
}

function validateSync(
  input: QueryValidationInput,
  statements: readonly Ast[],
): QueryValidationResult {
  const visible = visibleOf(input.model);
  const identifiers: IdentifierResolution[] = [];
  const touchedEntities: Id[] = [];
  const touchedFields: Id[] = [];
  const touch = (list: Id[], id: Id) => {
    if (!list.includes(id)) list.push(id);
  };
  const statementKinds: string[] = [];

  for (const statement of statements) {
    const type = typeof statement.type === 'string' ? statement.type.toUpperCase() : 'UNKNOWN';
    statementKinds.push(type);

    // CTE names are query-local tables: `WITH recent AS (…) SELECT * FROM recent`.
    const cteNames = new Set<string>();
    for (const node of nodes(statement)) {
      for (const cte of Array.isArray(node.with) ? node.with : []) {
        const name = isAst(cte) && isAst(cte.name) ? cte.name.value : undefined;
        if (typeof name === 'string') cteNames.add(normalizeName(name));
      }
    }

    // Tables: every `{ table, as, loc }` in a FROM / JOIN / UPDATE / INSERT / DELETE list.
    const aliases = new Map<string, Entity | null>(); // alias or name → entity (null = CTE/derived)
    const claimed = new Set<number>();
    for (const node of nodes(statement)) {
      if (typeof node.table !== 'string' || node.type === 'column_ref' || !('as' in node)) continue;
      const name = node.table;
      const found = locate(input.query, node.loc, name, claimed);
      const range = found?.range ?? null;
      const alias = typeof node.as === 'string' ? node.as : null;
      if (cteNames.has(normalizeName(name))) {
        aliases.set(normalizeName(alias ?? name), null);
        if (range !== null) {
          identifiers.push({
            text: found?.text ?? name,
            range,
            role: 'alias',
            status: 'alias-local',
            targetId: null,
            entityId: null,
            messageCode: null,
            messageParams: {},
            suggestions: [],
          });
        }
        continue;
      }
      const entity = visible.entities.get(normalizeName(name));
      aliases.set(normalizeName(name), entity ?? null);
      if (alias !== null) aliases.set(normalizeName(alias), entity ?? null);
      if (entity !== undefined) touch(touchedEntities, entity.id);
      if (found === null) continue;
      const { text } = found;
      identifiers.push(
        entity === undefined
          ? {
              text,
              range: found.range,
              role: 'entity',
              status: 'unknown',
              targetId: null,
              entityId: null,
              messageCode: CODE.unknownRelation,
              messageParams: { name },
              suggestions: suggest(
                name,
                [...visible.entities.values()].map((e) => e.name),
              ),
            }
          : {
              text,
              range: found.range,
              role: 'entity',
              status: 'resolved',
              targetId: entity.id,
              entityId: entity.id,
              messageCode: null,
              messageParams: {},
              suggestions: [],
            },
      );
    }
    const inScope = [...new Set([...aliases.values()].filter((e): e is Entity => e !== null))];
    const selectAliases = new Set<string>();
    for (const node of nodes(statement)) {
      for (const column of Array.isArray(node.columns) ? node.columns : []) {
        if (isAst(column) && typeof column.as === 'string')
          selectAliases.add(normalizeName(column.as));
      }
    }

    // Columns.
    for (const node of nodes(statement)) {
      if (node.type !== 'column_ref') continue;
      const column =
        typeof node.column === 'string'
          ? node.column
          : isAst(node.column) && isAst(node.column.expr)
            ? node.column.expr.value
            : undefined;
      if (typeof column !== 'string' || column === '*') continue;
      const qualified = typeof node.table === 'string' ? `${node.table}.${column}` : column;
      const found = locate(input.query, node.loc, qualified, claimed);
      if (found === null) continue;
      const { text, range } = found;
      const qualifier = typeof node.table === 'string' ? normalizeName(node.table) : null;
      const base = { text, range, role: 'field' as const };
      if (qualifier !== null && aliases.has(qualifier) && aliases.get(qualifier) === null) {
        identifiers.push({
          ...base,
          status: 'unchecked',
          targetId: null,
          entityId: null,
          messageCode: null,
          messageParams: {},
          suggestions: [],
        });
        continue;
      }
      const tables =
        qualifier === null
          ? inScope
          : [aliases.get(qualifier)].filter((e): e is Entity => e !== undefined && e !== null);
      if (qualifier === null && selectAliases.has(normalizeName(column))) {
        identifiers.push({
          ...base,
          role: 'alias',
          status: 'alias-local',
          targetId: null,
          entityId: null,
          messageCode: null,
          messageParams: {},
          suggestions: [],
        });
        continue;
      }
      const matches = tables.flatMap((t) =>
        visible.fieldsOf(t.id).filter((f) => normalizeName(f.name) === normalizeName(column)),
      );
      const match = matches[0];
      if (matches.length === 1 && match !== undefined) {
        touch(touchedFields, match.id);
        touch(touchedEntities, match.entityId);
        identifiers.push({
          ...base,
          status: 'resolved',
          targetId: match.id,
          entityId: match.entityId,
          messageCode: null,
          messageParams: {},
          suggestions: [],
        });
      } else if (matches.length > 1) {
        identifiers.push({
          ...base,
          status: 'ambiguous',
          targetId: null,
          entityId: null,
          messageCode: CODE.unknownColumn,
          messageParams: { name: column },
          suggestions: [],
        });
      } else {
        identifiers.push({
          ...base,
          status: 'unknown',
          targetId: null,
          entityId: null,
          messageCode: CODE.unknownColumn,
          messageParams: { name: column },
          suggestions: suggest(
            column,
            tables.flatMap((t) => visible.fieldsOf(t.id).map((f) => f.name)),
          ),
        });
      }
    }
  }

  identifiers.sort((a, b) => a.range.start - b.range.start);
  return {
    parsed: true,
    parseErrors: [],
    identifiers,
    touchedEntityIds: touchedEntities,
    touchedFieldIds: touchedFields,
    // Core never supplies `restrictedProbe` (§12.1): hidden references read as unknown above.
    hiddenReferences: [],
    statementKinds,
  };
}

const failed = (message: string, query: string): QueryValidationResult => ({
  parsed: false,
  parseErrors: [{ message, range: { start: 0, end: query.length, line: 1, column: 1 } }],
  identifiers: [],
  touchedEntityIds: [],
  touchedFieldIds: [],
  hiddenReferences: [],
  statementKinds: [],
});

/** SQLite's own reading: compiled (never run) against the redacted design's DDL. */
async function compileWithSqlite(input: QueryValidationInput): Promise<QueryValidationResult> {
  const db = await openMemory();
  try {
    const ddl = renderStatements(
      buildExport({
        model: input.model,
        options: {
          format: 'ddl',
          includeComments: false,
          includeDrops: false,
          includeIfNotExists: false,
          engineOptions: {},
        },
        context: input.context,
      }),
    );
    db.exec(ddl);
    try {
      db.prepare(input.query);
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error), input.query);
    }
  } finally {
    db.close();
  }
  const visible = visibleOf(input.model);
  const words = new Set(
    (input.query.match(/[A-Za-z_$][\w$]*/g) ?? []).map((w) => normalizeName(w)),
  );
  const entities = [...visible.entities.values()].filter((e) => words.has(normalizeName(e.name)));
  return {
    parsed: true,
    parseErrors: [],
    identifiers: [],
    touchedEntityIds: entities.map((e) => e.id),
    touchedFieldIds: entities.flatMap((e) =>
      visible
        .fieldsOf(e.id)
        .filter((f) => words.has(normalizeName(f.name)))
        .map((f) => f.id),
    ),
    hiddenReferences: [],
    statementKinds: [],
  };
}

export const QUERY_VALIDATOR: QueryValidator = {
  async validate(input) {
    let statements: readonly Ast[];
    try {
      statements = await parseSqlite(input.query);
    } catch {
      return compileWithSqlite(input);
    }
    return validateSync(input, statements);
  },
};
