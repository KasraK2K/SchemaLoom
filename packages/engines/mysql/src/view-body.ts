import { canonicalFunctions, loadMySqlParser } from './parser.js';

/**
 * Drift (ROADMAP known gap) — two view bodies are the same when their parse trees are, after
 * undoing what `SHOW CREATE VIEW` adds to a body it re-prints:
 *
 * - backticks, and parentheses (MySQL adds them, MariaDB drops them);
 * - `orders.id` where `orders` is the statement's only table (or its alias);
 * - `AS id` on `id`, and the generated name of an unaliased expression (`AS upper(note)`);
 * - `count(0)` for `count(*)`, and MariaDB's `ucase`/`lcase`.
 *
 * ponytail: an alias that is not a bare identifier is taken for a generated one and dropped,
 * so a hand-written `AS \`a b\`` is not compared. A multi-table view written without
 * qualifiers still reads as changed.
 */
export async function sameViewBody(a: string, b: string): Promise<boolean> {
  try {
    const parser = await loadMySqlParser(false);
    const [x, y] = [parser.parse(a), parser.parse(b)].map((ast) =>
      JSON.stringify(canonical(canonicalFunctions(ast), new Set())),
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

/** `from` holds the names a column may be qualified with and still mean the only table. */
function canonical(value: unknown, from: ReadonlySet<unknown>): unknown {
  if (Array.isArray(value)) return value.map((v) => canonical(v, from));
  if (!isNode(value)) return value;
  if (value.type === 'backticks_quote_string' || value.type === 'default') return value.value;

  // `from (a join b)`: the parser wraps a parenthesised FROM as `{ expr: [a, b], joins: [] }`.
  if (value.type === 'select' && isNode(value.from) && Array.isArray(value.from.expr)) {
    const { joins } = value.from;
    if (Array.isArray(joins) && joins.length === 0) {
      return canonical({ ...value, from: value.from.expr }, from);
    }
  }
  if (value.type === 'select' && Array.isArray(value.from) && value.from.length === 1) {
    const only = value.from[0] as Node;
    from = new Set([nameOf(only.as ?? only.table)]);
  }
  if (value.type === 'column_ref' && from.has(nameOf(value.table))) {
    return canonical({ ...value, table: null }, from);
  }
  if (value.type === 'aggr_func' && isNode(value.args) && isNode(value.args.expr)) {
    if (value.args.expr.type === 'star') {
      return canonical(
        { ...value, args: { ...value.args, expr: { type: 'number', value: 0 } } },
        from,
      );
    }
  }
  if (isNode(value.expr) && typeof value.as === 'string') {
    const column = value.expr.type === 'column_ref' ? nameOf(value.expr.column) : undefined;
    if (value.as === column || !/^[\w$]+$/.test(value.as)) {
      return canonical({ ...value, as: null }, from);
    }
  }

  const out: Node = {};
  for (const [key, v] of Object.entries(value)) {
    if (v === null || key === 'parentheses' || key === 'loc') continue;
    out[key] = canonical(v, from);
  }
  return out;
}
