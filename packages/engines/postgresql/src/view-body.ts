import type { ViewColumns } from '@schemaloom/engine-sdk';
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
 * - `orders.id` where `orders` is the statement's only relation;
 * - in a join, an unqualified `name` that only one of the joined tables has (per `columns`),
 *   which the server writes `c.name`.
 *
 * ponytail: casts are dropped by shape, not by type, so `'1'::int` and `'1'` compare equal.
 * Drift may miss such a change; it no longer cries wolf on every pg_dump.
 */
export async function sameViewBody(a: string, b: string, columns?: ViewColumns): Promise<boolean> {
  try {
    const parser = await loadSqlParser();
    const [x, y] = await Promise.all([parser.parse(a), parser.parse(b)]);
    const text = (ast: unknown) => JSON.stringify(canonical(ast, NO_SCOPE, columns));
    return text(x) === text(y);
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

/**
 * `only`: the names a column may be qualified with and still mean the statement's only relation.
 * `qualify`: in a join, the qualifier the server puts on an unqualified column.
 */
interface Scope {
  readonly only: ReadonlySet<string>;
  readonly qualify: (column: string) => string | undefined;
}
const NO_SCOPE: Scope = { only: new Set(), qualify: () => undefined };
const qualifierOf = (rel: Node): string =>
  String(isNode(rel.alias) ? rel.alias.aliasname : rel.relname);

/** The tables of a FROM item; undefined when it holds a subquery or a function, whose columns
 *  nothing here knows. */
function tablesOf(item: unknown): Node[] | undefined {
  if (!isNode(item)) return undefined;
  if (isNode(item.RangeVar)) return [item.RangeVar];
  if (isNode(item.JoinExpr)) {
    const [l, r] = [tablesOf(item.JoinExpr.larg), tablesOf(item.JoinExpr.rarg)];
    return l === undefined || r === undefined ? undefined : [...l, ...r];
  }
  return undefined;
}

/** A join of plain tables: who owns each column. Undefined when any table is unknown. */
function joinScope(from: readonly unknown[], columns: ViewColumns | undefined): Scope | undefined {
  const rels = from.map(tablesOf);
  if (columns === undefined || rels.some((r) => r === undefined)) return undefined;
  const tables = rels.flat().map((rel) => {
    const known = rel === undefined ? undefined : columns(String(rel.relname));
    return rel === undefined || known === undefined
      ? undefined
      : { qualifier: qualifierOf(rel), known };
  });
  if (tables.length < 2 || tables.some((t) => t === undefined)) return undefined;
  return {
    only: new Set(),
    qualify: (column) => {
      const owners = tables.filter((t) => t?.known.includes(column));
      return owners.length === 1 ? owners[0]?.qualifier : undefined;
    },
  };
}

function canonical(value: unknown, scope: Scope, columns: ViewColumns | undefined): unknown {
  if (Array.isArray(value)) return value.map((v) => canonical(v, scope, columns));
  if (!isNode(value)) return value;

  if (isNode(value.SelectStmt)) {
    const relations = Array.isArray(value.SelectStmt.fromClause) ? value.SelectStmt.fromClause : [];
    const only = relations.length === 1 && isNode(relations[0]) ? relations[0].RangeVar : undefined;
    if (isNode(only)) {
      scope = { only: new Set([qualifierOf(only)]), qualify: () => undefined };
    } else {
      scope = joinScope(relations, columns) ?? scope;
    }
  }
  if (isNode(value.TypeCast)) {
    const { arg, typeName } = value.TypeCast;
    const names = isNode(typeName) ? svals(typeName.names) : [];
    if (isNode(arg) && ('A_Const' in arg || 'A_ArrayExpr' in arg || names.at(-1) === 'text')) {
      return canonical(arg, scope, columns);
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
        scope,
        columns,
      );
    }
  }
  if (isNode(value.ColumnRef)) {
    const fields = value.ColumnRef.fields;
    if (Array.isArray(fields) && fields.length === 2 && scope.only.has(svals(fields)[0] ?? '')) {
      return canonical(
        { ColumnRef: { ...value.ColumnRef, fields: fields.slice(1) } },
        scope,
        columns,
      );
    }
    const name = Array.isArray(fields) && fields.length === 1 ? svals(fields)[0] : undefined;
    const qualifier = name === undefined ? undefined : scope.qualify(name);
    if (qualifier !== undefined) {
      const qualified = [{ String: { sval: qualifier } }, ...(fields as unknown[])];
      return canonical({ ColumnRef: { ...value.ColumnRef, fields: qualified } }, scope, columns);
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
      return canonical({ ResTarget: rest }, scope, columns);
    }
  }

  const out: Node = {};
  for (const [key, v] of Object.entries(value)) {
    if (key === 'location' || key === 'stmt_len' || key === 'stmt_location') continue;
    if (key === 'schemaname' && v === 'public') continue;
    out[key] = canonical(v, scope, columns);
  }
  return out;
}
