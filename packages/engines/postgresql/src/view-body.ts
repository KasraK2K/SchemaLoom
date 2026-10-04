import { loadSqlParser } from './parser.js';

/**
 * Drift (ROADMAP known gap) — two view bodies are the same when their parse trees are, after
 * undoing what PostgreSQL's `pg_get_viewdef` adds to a body it re-prints:
 *
 * - parentheses and layout: gone in the tree once `location`s are dropped;
 * - `public.` on a relation;
 * - casts on literals and arrays (`(100)::numeric`, `'paid'::text`) and to `text`
 *   (`(status)::text`, which it adds to compare a varchar);
 * - `x IN (a, b)` spelled `x = ANY (ARRAY[a, b])`, and `NOT IN` as `<> ALL`;
 * - `AS upper` on an unaliased `upper(…)`, `AS id` on `id`;
 * - `orders.id` where `orders` is the statement's only relation.
 *
 * ponytail: casts are dropped by shape, not by type, so `'1'::int` and `'1'` compare equal.
 * Drift may miss such a change; it no longer cries wolf on every pg_dump. A multi-table view
 * written without qualifiers still reads as changed.
 */
export async function sameViewBody(a: string, b: string): Promise<boolean> {
  try {
    const parser = await loadSqlParser();
    const [x, y] = await Promise.all([parser.parse(a), parser.parse(b)]);
    return JSON.stringify(canonical(x, new Set())) === JSON.stringify(canonical(y, new Set()));
  } catch {
    return false;
  }
}

type Node = Record<string, unknown>;
const isNode = (v: unknown): v is Node => typeof v === 'object' && v !== null && !Array.isArray(v);
const svals = (list: unknown): string[] =>
  Array.isArray(list)
    ? list.map((n) => (isNode(n) && isNode(n.String) ? String(n.String.sval) : ''))
    : [];

/** `from` holds the names a column may be qualified with and still mean the only relation. */
function canonical(value: unknown, from: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => canonical(v, from));
  if (!isNode(value)) return value;

  if (isNode(value.SelectStmt)) {
    const relations = Array.isArray(value.SelectStmt.fromClause) ? value.SelectStmt.fromClause : [];
    const only = relations.length === 1 && isNode(relations[0]) ? relations[0].RangeVar : undefined;
    if (isNode(only)) {
      const alias = isNode(only.alias) ? only.alias.aliasname : undefined;
      from = new Set([String(alias ?? only.relname)]);
    }
  }
  if (isNode(value.TypeCast)) {
    const { arg, typeName } = value.TypeCast;
    const names = isNode(typeName) ? svals(typeName.names) : [];
    if (isNode(arg) && ('A_Const' in arg || 'A_ArrayExpr' in arg || names.at(-1) === 'text')) {
      return canonical(arg, from);
    }
  }
  if (isNode(value.A_Expr) && value.A_Expr.kind === 'AEXPR_IN') {
    const { rexpr, name } = value.A_Expr;
    const items = isNode(rexpr) && isNode(rexpr.List) ? rexpr.List.items : undefined;
    if (items !== undefined) {
      return canonical(
        {
          A_Expr: {
            ...value.A_Expr,
            kind: svals(name)[0] === '<>' ? 'AEXPR_OP_ALL' : 'AEXPR_OP_ANY',
            rexpr: { A_ArrayExpr: { elements: items } },
          },
        },
        from,
      );
    }
  }
  if (isNode(value.ColumnRef)) {
    const fields = value.ColumnRef.fields;
    if (Array.isArray(fields) && fields.length === 2 && from.has(svals(fields)[0] ?? '')) {
      return canonical({ ColumnRef: { ...value.ColumnRef, fields: fields.slice(1) } }, from);
    }
  }
  if (isNode(value.ResTarget) && typeof value.ResTarget.name === 'string') {
    const val = value.ResTarget.val;
    const implied = isNode(val)
      ? isNode(val.FuncCall)
        ? svals(val.FuncCall.funcname).at(-1)
        : isNode(val.ColumnRef)
          ? svals(val.ColumnRef.fields).at(-1)
          : undefined
      : undefined;
    if (implied === value.ResTarget.name) {
      const { name: _implied, ...rest } = value.ResTarget;
      return canonical({ ResTarget: rest }, from);
    }
  }

  const out: Node = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'location' || key === 'stmt_len' || key === 'stmt_location') continue;
    if (key === 'schemaname' && v === 'public') continue;
    out[key] = canonical(v, from);
  }
  return out;
}
