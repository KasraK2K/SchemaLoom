/**
 * Reading `libpg-query`'s parse tree WITHOUT `any`.
 *
 * The module's own typings are `any`-heavy and `parser.ts` deliberately narrows its output to
 * `unknown` at the seam. Everything past that seam goes through the guards below, so a shape
 * that is not what we expected produces `undefined` — a reported statement — rather than a
 * `TypeError` thrown out of `import()`, which §9 invariant 4 forbids.
 *
 * The tree's own conventions, for anyone reading it for the first time:
 *  - every node is a one-key wrapper: `{ CreateStmt: { … } }`
 *  - a bare string is `{ String: { sval: 'orders' } }`, an integer `{ Integer: { ival: 3 } }`
 *  - protobuf-json OMITS zero and false, so `{ "ival": {} }` is the integer 0 and an absent
 *    `unique` is `false`. Every reader here defaults accordingly.
 */

export type AstNode = Readonly<Record<string, unknown>>;

export function asNode(value: unknown): AstNode | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as AstNode)
    : undefined;
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The single key of a wrapper node: 'CreateStmt', 'ColumnDef', 'String'. */
export function nodeTag(value: unknown): string | undefined {
  const node = asNode(value);
  if (node === undefined) return undefined;
  const keys = Object.keys(node);
  return keys.length === 1 ? keys[0] : undefined;
}

/** The body of a wrapper node when its tag matches, else undefined. */
export function unwrap(value: unknown, tag: string): AstNode | undefined {
  const node = asNode(value);
  return node === undefined ? undefined : asNode(node[tag]);
}

export function field(node: AstNode, key: string): unknown {
  return node[key];
}

export function str(node: AstNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function bool(node: AstNode, key: string): boolean {
  return node[key] === true;
}

export function int(node: AstNode, key: string): number | undefined {
  const value = node[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function children(node: AstNode, key: string): readonly AstNode[] {
  return asArray(node[key])
    .map(asNode)
    .filter((child): child is AstNode => child !== undefined);
}

/** `[{ String: { sval } }, …]` -> `['public', 'orders']`. */
export function stringList(node: AstNode, key: string): readonly string[] {
  const out: string[] = [];
  for (const item of children(node, key)) {
    const body = unwrap(item, 'String');
    const value = body === undefined ? undefined : str(body, 'sval');
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** An `{ Integer: { ival } }` node, with protobuf-json's omitted zero restored. */
export function integerValue(value: unknown): number | undefined {
  const body = unwrap(value, 'Integer');
  if (body === undefined) return undefined;
  return int(body, 'ival') ?? 0;
}

/** `{ A_Const: { ival: { ival: 12 } } }` -> 12; also handles `fval` and `sval` constants. */
export function constantValue(value: unknown): string | number | undefined {
  const constant = unwrap(value, 'A_Const');
  if (constant === undefined) return undefined;

  const ival = asNode(constant.ival);
  if (ival !== undefined) return int(ival, 'ival') ?? 0;
  const fval = asNode(constant.fval);
  if (fval !== undefined) {
    const text = str(fval, 'fval');
    return text === undefined ? undefined : Number(text);
  }
  const sval = asNode(constant.sval);
  if (sval !== undefined) return str(sval, 'sval') ?? '';
  return undefined;
}

/**
 * The SMALLEST `location` anywhere in a subtree.
 *
 * Load-bearing, and the reason there is no `node.location` read anywhere in the importer: a
 * binary operator's own `location` is the OPERATOR's offset, so `total > 0` reports 116 —
 * pointing at `>`. Recovering the expression text from there yields `> 0`. The minimum over
 * the subtree is 110, which is where `total` starts, which is the expression.
 */
export function minLocation(value: unknown): number | undefined {
  let best: number | undefined;

  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    const node = asNode(current);
    if (node === undefined) return;
    for (const [key, child] of Object.entries(node)) {
      if (key === 'location') {
        if (typeof child === 'number' && child >= 0 && (best === undefined || child < best)) {
          best = child;
        }
        continue;
      }
      visit(child);
    }
  };

  visit(value);
  return best;
}

/** The statement nodes of a `parse()` result. An unexpected shape yields none, which the
 *  caller reports as a failed statement. */
export function statementsOf(parsed: unknown): readonly unknown[] {
  const root = asNode(parsed);
  if (root === undefined) return [];
  return asArray(root.stmts)
    .map((raw) => asNode(raw)?.stmt)
    .filter((stmt) => stmt !== undefined);
}

/** A `DefElem` list (`WITH (fillfactor = 90)`) as a plain map of scalar values. */
export function defElements(node: AstNode, key: string): ReadonlyMap<string, string | number> {
  const out = new Map<string, string | number>();
  for (const item of children(node, key)) {
    const element = unwrap(item, 'DefElem');
    if (element === undefined) continue;
    const name = str(element, 'defname');
    if (name === undefined) continue;
    const value = integerValue(element.arg) ?? constantValue(element.arg);
    const stringArg = unwrap(element.arg, 'String');
    const resolved = value ?? (stringArg === undefined ? undefined : str(stringArg, 'sval'));
    if (resolved !== undefined) out.set(name, resolved);
  }
  return out;
}

export interface QualifiedName {
  readonly schema: string | undefined;
  readonly name: string;
}

/** A `RangeVar` — `{ schemaname?, relname }`. */
export function rangeVar(value: unknown): QualifiedName | undefined {
  const node = asNode(value);
  if (node === undefined) return undefined;
  const name = str(node, 'relname');
  return name === undefined ? undefined : { schema: str(node, 'schemaname'), name };
}

/** A dotted name list — `CREATE TYPE public.order_status` gives `['public','order_status']`. */
export function qualifiedFromList(parts: readonly string[]): QualifiedName | undefined {
  if (parts.length === 0) return undefined;
  const name = parts[parts.length - 1];
  if (name === undefined) return undefined;
  return { schema: parts.length > 1 ? parts[parts.length - 2] : undefined, name };
}

export interface ParsedTypeName {
  /** the spelling to hand `TypeCatalog.buildRef`, with `pg_catalog.` stripped */
  readonly name: string;
  readonly args: readonly (string | number)[];
  readonly dimensions: number;
}

/** A `TypeName` node: names, typmods and array bounds. */
export function typeName(value: unknown): ParsedTypeName | undefined {
  const node = asNode(value);
  if (node === undefined) return undefined;
  const parts = stringList(node, 'names').filter((part) => part !== 'pg_catalog');
  if (parts.length === 0) return undefined;

  const args: (string | number)[] = [];
  for (const typmod of children(node, 'typmods')) {
    const value_ = constantValue(typmod);
    if (value_ !== undefined) args.push(value_);
  }

  return {
    name: parts.join('.'),
    args,
    dimensions: children(node, 'arrayBounds').length,
  };
}
