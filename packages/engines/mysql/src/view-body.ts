import type { ViewColumns } from '@schemaloom/engine-sdk';
import { canonicalFunctions, loadMySqlParser } from './parser.js';

/**
 * Drift (ROADMAP known gap) — two view bodies are the same when their parse trees are, after
 * undoing what `SHOW CREATE VIEW` adds to a body it re-prints:
 *
 * - backticks, and parentheses (MySQL adds them, MariaDB drops them);
 * - `orders.id` where `orders` is the statement's only table (or its alias);
 * - in a join, an unqualified `name` that only one of the joined tables has (per `columns`),
 *   which the server writes `c.name`;
 * - `AS id` on `id`, and the generated name of an unaliased expression (`AS upper(note)`);
 * - `count(0)` for `count(*)`, and MariaDB's `ucase`/`lcase`.
 *
 * ponytail: an alias that is not a bare identifier is taken for a generated one and dropped,
 * so a hand-written `AS \`a b\`` is not compared.
 */
export async function sameViewBody(a: string, b: string, columns?: ViewColumns): Promise<boolean> {
  try {
    const parser = await loadMySqlParser(false);
    const [x, y] = [parser.parse(a), parser.parse(b)].map((ast) =>
      JSON.stringify(canonical(canonicalFunctions(ast), NO_SCOPE, columns)),
    );
    return x === y;
  } catch {
    return false;
  }
}

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
/** `` `o` `` and a `{ type: 'default' }` name part read as the plain name. */
const nameOf = (v: unknown): unknown =>
  isNode(v) && (v.type === 'backticks_quote_string' || v.type === 'default') ? v.value : v;

/**
 * `only`: the names a column may be qualified with and still mean the statement's only table.
 * `qualify`: in a join, the qualifier the server puts on an unqualified column.
 */
interface Scope {
  readonly only: ReadonlySet<unknown>;
  readonly qualify: (column: unknown) => unknown;
}
const NO_SCOPE: Scope = { only: new Set(), qualify: () => undefined };

/** A join of plain tables: who owns each column. Undefined when any table is unknown or a
 *  FROM item is a subquery, whose columns nothing here knows. */
function joinScope(from: readonly unknown[], columns: ViewColumns | undefined): Scope | undefined {
  if (columns === undefined) return undefined;
  const tables = from.map((item) => {
    if (!isNode(item) || typeof nameOf(item.table) !== 'string') return undefined;
    const known = columns(String(nameOf(item.table)));
    return known === undefined ? undefined : { qualifier: nameOf(item.as ?? item.table), known };
  });
  if (tables.some((t) => t === undefined)) return undefined;
  return {
    only: new Set(),
    qualify: (column) => {
      const name = String(column).toLowerCase();
      const owners = tables.filter((t) => t?.known.some((k) => k.toLowerCase() === name));
      return owners.length === 1 ? owners[0]?.qualifier : undefined;
    },
  };
}

function canonical(value: unknown, scope: Scope, columns: ViewColumns | undefined): unknown {
  if (Array.isArray(value)) return value.map((v) => canonical(v, scope, columns));
  if (!isNode(value)) return value;
  if (value.type === 'backticks_quote_string' || value.type === 'default') return value.value;

  // `from (a join b)`: the parser wraps a parenthesised FROM as `{ expr: [a, b], joins: [] }`.
  if (value.type === 'select' && isNode(value.from) && Array.isArray(value.from.expr)) {
    const { joins } = value.from;
    if (Array.isArray(joins) && joins.length === 0) {
      return canonical({ ...value, from: value.from.expr }, scope, columns);
    }
  }
  if (value.type === 'select' && Array.isArray(value.from) && value.from.length === 1) {
    const only = value.from[0] as Node;
    scope = { only: new Set([nameOf(only.as ?? only.table)]), qualify: () => undefined };
  } else if (value.type === 'select' && Array.isArray(value.from)) {
    scope = joinScope(value.from, columns) ?? scope;
  }
  if (value.type === 'column_ref' && scope.only.has(nameOf(value.table))) {
    return canonical({ ...value, table: null }, scope, columns);
  }
  if (value.type === 'column_ref' && value.table === null) {
    const qualifier = scope.qualify(
      nameOf(isNode(value.column) ? value.column.expr : value.column),
    );
    if (qualifier !== undefined) return canonical({ ...value, table: qualifier }, scope, columns);
  }
  if (value.type === 'aggr_func' && isNode(value.args) && isNode(value.args.expr)) {
    if (value.args.expr.type === 'star') {
      return canonical(
        { ...value, args: { ...value.args, expr: { type: 'number', value: 0 } } },
        scope,
        columns,
      );
    }
  }
  if (isNode(value.expr) && typeof value.as === 'string') {
    const column = value.expr.type === 'column_ref' ? nameOf(value.expr.column) : undefined;
    if (value.as === column || !/^[\w$]+$/.test(value.as)) {
      return canonical({ ...value, as: null }, scope, columns);
    }
  }

  const out: Node = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === null || key === 'parentheses' || key === 'loc') continue;
    out[key] = canonical(v, scope, columns);
  }
  return out;
}
