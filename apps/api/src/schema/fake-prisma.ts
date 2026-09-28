import type { PrismaService } from '../prisma/prisma.service';

/**
 * A tiny in-memory stand-in for the handful of Prisma delegates `src/schema/**` uses.
 *
 * Docker is not a test dependency here: every rule this module encodes — the version
 * guard, the server-assigned ordinal, the cascade post-images — is a rule about the
 * SHAPE of the statements we issue, and a fake that records those statements and applies
 * them to arrays tests exactly that. The queries themselves are ordinary indexed lookups
 * that Postgres, not this code, is responsible for.
 *
 * Deliberately small: equality, `{ in }`, `{ has }`, `OR`, `orderBy`, and `{ increment }` in `data`.
 * The moment a test needs more than that, it wants an integration test instead.
 */

export type Row = Record<string, unknown>;

export interface Call {
  readonly model: string;
  readonly method: string;
  readonly args: Row;
}

export type Store = Record<string, Row[]>;

const MODELS = [
  'project',
  'area',
  'namespace',
  'customType',
  'entity',
  'field',
  'constraint',
  'constraintColumn',
  'schemaIndex',
  'schemaIndexColumn',
  'link',
  'linkEndpoint',
  'doc',
  'savedQuery',
  'savedQueryEntity',
] as const;

/** `parent.create({ data: { columns: { create: [...] } } })` → which table the children
 *  land in, and which column points back. */
const NESTED: Readonly<Record<string, { key: string; table: string; fk: string }>> = {
  constraint: { key: 'columns', table: 'constraintColumn', fk: 'constraintId' },
  schemaIndex: { key: 'columns', table: 'schemaIndexColumn', fk: 'indexId' },
  link: { key: 'endpoints', table: 'linkEndpoint', fk: 'linkId' },
};

function matches(row: Row, where: Row | undefined): boolean {
  if (where === undefined) return true;
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') {
      return Array.isArray(expected) && expected.some((w) => matches(row, w as Row));
    }
    if (expected !== null && typeof expected === 'object' && 'has' in expected) {
      const cell = row[key];
      return Array.isArray(cell) && cell.includes(expected.has);
    }
    if (expected !== null && typeof expected === 'object' && 'in' in expected) {
      const list = (expected as { in: unknown[] }).in;
      return list.includes(row[key]);
    }
    return row[key] === expected;
  });
}

type OrderBy = Record<string, 'asc' | 'desc'>;

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const clauses: OrderBy[] = Array.isArray(orderBy)
    ? (orderBy as OrderBy[])
    : orderBy === undefined
      ? []
      : [orderBy as OrderBy];
  if (clauses.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const clause of clauses) {
      for (const [key, direction] of Object.entries(clause)) {
        const left = a[key];
        const right = b[key];
        if (left === right) continue;
        const cmp =
          typeof left === 'number' && typeof right === 'number'
            ? left - right
            : String(left) < String(right)
              ? -1
              : 1;
        return direction === 'desc' ? -cmp : cmp;
      }
    }
    return 0;
  });
}

function applyData(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value !== null && typeof value === 'object' && 'increment' in value) {
      const by = (value as { increment: number }).increment;
      const current = row[key];
      row[key] = typeof current === 'bigint' ? current + BigInt(by) : Number(current ?? 0) + by;
      continue;
    }
    row[key] = value;
  }
}

export interface FakePrisma {
  readonly client: PrismaService;
  readonly store: Store;
  readonly calls: Call[];
  /** Every call as `"model.method"`, which is what most assertions actually want. */
  names(): string[];
  callsTo(model: string, method: string): Call[];
}

export interface FakeOptions {
  /**
   * Makes every `findMany` hang until the returned promise resolves. The loader's
   * parallelism test uses it to prove all twelve scans are in flight at once rather than
   * awaited one after another.
   */
  readonly gate?: Promise<void>;
}

export function fakePrisma(seed: Partial<Store> = {}, options: FakeOptions = {}): FakePrisma {
  const store: Store = {};
  for (const model of MODELS) store[model] = [...(seed[model] ?? [])];

  const calls: Call[] = [];
  const rowsOf = (model: string): Row[] => store[model] ?? [];

  const delegate = (model: string) => {
    const record = (method: string, args: Row): void => {
      calls.push({ model, method, args });
    };
    return {
      // Plain functions returning promises, not `async` ones: there is nothing to await
      // in an array, and the gate is the only real suspension point.
      findMany: (args: Row = {}): Promise<Row[]> => {
        record('findMany', args);
        const run = (): Row[] =>
          sortRows(
            rowsOf(model).filter((r) => matches(r, args.where as Row | undefined)),
            args.orderBy,
          );
        return options.gate ? options.gate.then(run) : Promise.resolve(run());
      },
      findFirst: (args: Row = {}): Promise<Row | null> => {
        record('findFirst', args);
        const hit = sortRows(
          rowsOf(model).filter((r) => matches(r, args.where as Row | undefined)),
          args.orderBy,
        )[0];
        return Promise.resolve(hit ?? null);
      },
      count: (args: Row = {}): Promise<number> => {
        record('count', args);
        return Promise.resolve(
          rowsOf(model).filter((r) => matches(r, args.where as Row | undefined)).length,
        );
      },
      create: (args: Row = {}): Promise<Row> => {
        record('create', args);
        const raw = args.data as Row;
        const nested = NESTED[model];
        const data: Row = {};
        for (const [key, value] of Object.entries(raw)) {
          if (key !== nested?.key) data[key] = value;
        }
        if (nested !== undefined) {
          const children = raw[nested.key] as { create: Row[] } | undefined;
          for (const child of children?.create ?? []) {
            rowsOf(nested.table).push({ ...child, [nested.fk]: raw.id });
          }
        }
        // Prisma's `@default(cuid())`, for the models whose id the caller never sends.
        if (!('id' in data) && model === 'savedQuery') data.id = `${model}_${String(rowsOf(model).length + 1)}`;
        rowsOf(model).push(data);
        return Promise.resolve(data);
      },
      createMany: (args: Row = {}): Promise<{ count: number }> => {
        record('createMany', args);
        const data = args.data as Row[];
        for (const row of data) rowsOf(model).push({ ...row });
        return Promise.resolve({ count: data.length });
      },
      update: (args: Row = {}): Promise<Row> => {
        record('update', args);
        const hit = rowsOf(model).find((r) => matches(r, args.where as Row | undefined));
        if (hit === undefined) throw new Error(`no ${model} row matched update`);
        applyData(hit, args.data as Row);
        return Promise.resolve(hit);
      },
      updateMany: (args: Row = {}): Promise<{ count: number }> => {
        record('updateMany', args);
        const hits = rowsOf(model).filter((r) => matches(r, args.where as Row | undefined));
        for (const hit of hits) applyData(hit, args.data as Row);
        return Promise.resolve({ count: hits.length });
      },
      deleteMany: (args: Row = {}): Promise<{ count: number }> => {
        record('deleteMany', args);
        const keep = rowsOf(model).filter((r) => !matches(r, args.where as Row | undefined));
        const count = rowsOf(model).length - keep.length;
        store[model] = keep;
        return Promise.resolve({ count });
      },
    };
  };

  const client: Record<string, unknown> = {
    $transaction: (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => fn(client),
    // Recorded, not executed: a test asserts the statement and its bound values.
    $executeRaw: (strings: TemplateStringsArray, ...values: unknown[]): Promise<number> => {
      calls.push({ model: '$raw', method: 'executeRaw', args: { sql: strings.join('?'), values } });
      return Promise.resolve(0);
    },
  };
  for (const model of MODELS) client[model] = delegate(model);

  return {
    client: client as unknown as PrismaService,
    store,
    calls,
    names: () => calls.map((c) => `${c.model}.${c.method}`),
    callsTo: (model, method) => calls.filter((c) => c.model === model && c.method === method),
  };
}
