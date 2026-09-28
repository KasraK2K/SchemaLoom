import type { IdentifierResolution, QueryValidationResult, RedactedModel } from '@schemaloom/engine-sdk';
import { renderDiagnostic } from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import { redactedModel } from './conformance-fixtures.js';
import { column, fullyVisible, model, ns, table } from './fixture-model.js';
import { postgresEngine } from './index.js';
import { QUERY_VALIDATOR } from './query-validator.js';

const MODEL = fullyVisible(
  model({
    namespaces: [
      ns({ id: 'public', name: 'public', isDefault: true }),
      ns({ id: 'billing', name: 'billing' }),
    ],
    entities: [
      table({ id: 'en_orders', name: 'orders' }),
      table({ id: 'en_customers', name: 'customers' }),
      table({ id: 'en_invoices', name: 'invoices', namespaceId: 'billing' }),
    ],
    fields: [
      column({ id: 'fd_o_id', name: 'id', entityId: 'en_orders', ordinal: 0 }),
      column({ id: 'fd_o_cust', name: 'customer_id', entityId: 'en_orders', ordinal: 1 }),
      column({ id: 'fd_o_total', name: 'total', entityId: 'en_orders', ordinal: 2 }),
      column({ id: 'fd_c_id', name: 'id', entityId: 'en_customers', ordinal: 0 }),
      column({ id: 'fd_c_email', name: 'email', entityId: 'en_customers', ordinal: 1 }),
      column({ id: 'fd_i_id', name: 'id', entityId: 'en_invoices', ordinal: 0 }),
      column({ id: 'fd_i_order', name: 'order_id', entityId: 'en_invoices', ordinal: 1 }),
    ],
  }),
);

const context = { projectId: 'p1', serverVersion: '16' };

function run(query: string, m: RedactedModel = MODEL): Promise<QueryValidationResult> {
  return QUERY_VALIDATOR.validate({ query, model: m, context });
}

function brief(i: IdentifierResolution): string {
  return `${i.text}:${i.role}:${i.status}${i.targetId === null ? '' : `=${i.targetId}`}`;
}

describe('the query validator', () => {
  it('is attached to the engine', () => {
    expect(postgresEngine.queryValidator).toBe(QUERY_VALIDATOR);
    expect(postgresEngine.capabilities.features.queryValidation).toBe(true);
  });

  it('resolves qualified, unqualified and aliased columns, in source order', async () => {
    const result = await run('SELECT o.id, email, orders.total FROM orders JOIN customers c ON c.id = customer_id');
    // `o` is not in FROM (the table has no alias `o`), so it is an unknown qualifier.
    expect(result.identifiers.map(brief)).toEqual([
      'o:alias:unknown',
      'id:field:unchecked',
      'email:field:resolved=fd_c_email',
      'orders:entity:resolved=en_orders',
      'total:field:resolved=fd_o_total',
      'orders:entity:resolved=en_orders',
      'customers:entity:resolved=en_customers',
      'c:alias:alias-local',
      'c:alias:alias-local',
      'id:field:resolved=fd_c_id',
      'customer_id:field:resolved=fd_o_cust',
    ]);
    expect(result.parsed).toBe(true);
    expect(result.statementKinds).toEqual(['SELECT']);
  });

  it('flags an ambiguous unqualified column', async () => {
    const result = await run('SELECT id FROM orders, customers');
    const [id] = result.identifiers;
    expect(id?.status).toBe('ambiguous');
    expect(id?.messageCode).toBe('postgresql.query-ambiguous-column');
    expect(id?.messageParams).toMatchObject({ name: 'id', count: 2, tables: 'orders, customers' });
  });

  it('suggests near misses for an unknown table and column, and renders the message', async () => {
    const result = await run('SELECT totl FROM ordrs; SELECT totl FROM orders');
    const table_ = result.identifiers.find((i) => i.text === 'ordrs');
    expect(table_?.status).toBe('unknown');
    expect(table_?.suggestions).toEqual(['orders']);
    const col = result.identifiers.filter((i) => i.text === 'totl');
    // against an unknown table the column is unchecked, against a known one it is unknown
    expect(col.map((i) => i.status)).toEqual(['unchecked', 'unknown']);
    expect(col[1]?.suggestions).toEqual(['total']);
    const rendered = renderDiagnostic(
      postgresEngine.diagnosticMessages,
      postgresEngine.terminology,
      {
        code: table_?.messageCode ?? '',
        severity: 'error',
        params: table_?.messageParams ?? {},
        target: { type: 'project', id: 'p1' },
      },
      () => null,
    );
    expect(rendered).toBe('There is no table or view named “ordrs”');
  });

  it('resolves schema-qualified and quoted names, with ranges over the text as written', async () => {
    const query = 'SELECT i.order_id FROM "billing"."invoices" i, "public".Orders';
    const result = await run(query);
    expect(result.identifiers.map(brief)).toEqual([
      'i:alias:alias-local',
      'order_id:field:resolved=fd_i_order',
      '"billing"."invoices":entity:resolved=en_invoices',
      'i:alias:alias-local',
      '"public".Orders:entity:resolved=en_orders',
    ]);
    for (const i of result.identifiers) expect(query.slice(i.range.start, i.range.end)).toBe(i.text);
    // `invoices` is not on the search path
    const bare = await run('SELECT 1 FROM invoices');
    expect(bare.identifiers[0]?.status).toBe('unknown');
    expect(bare.identifiers[0]?.suggestions).toEqual([]);
  });

  it('treats CTE names and subquery aliases as local and their columns as unchecked', async () => {
    const result = await run(
      'WITH big AS (SELECT id FROM orders WHERE total > 1) ' +
        'SELECT big.id, s.n FROM big, (SELECT count(*) AS n FROM customers) s',
    );
    expect(result.identifiers.map(brief)).toEqual([
      'big:alias:alias-local',
      'id:field:resolved=fd_o_id',
      'orders:entity:resolved=en_orders',
      'total:field:resolved=fd_o_total',
      'big:alias:alias-local',
      'id:field:unchecked',
      's:alias:alias-local',
      'n:field:unchecked',
      'big:alias:alias-local',
      'count:function:unchecked',
      'customers:entity:resolved=en_customers',
      's:alias:alias-local',
    ]);
  });

  it('lets ORDER BY name an output alias and a correlated subquery see the outer FROM', async () => {
    const result = await run(
      'SELECT total AS t FROM orders o WHERE EXISTS (SELECT 1 FROM customers c WHERE c.id = o.customer_id) ORDER BY t',
    );
    expect(result.identifiers.filter((i) => i.status === 'unknown')).toEqual([]);
    expect(result.identifiers.at(-1)?.status).toBe('alias-local');
    expect(result.touchedFieldIds).toEqual(['fd_o_total', 'fd_c_id', 'fd_o_cust']);
  });

  it('never resolves a stub by its real name, nor a masked field', async () => {
    const m = redactedModel();
    const stub = await run('SELECT c.email FROM customers c', m);
    expect(stub.identifiers.find((i) => i.text === 'customers')?.status).toBe('unknown');
    expect(stub.touchedEntityIds).toEqual([]);
    // a stub's blanked name cannot be matched either
    expect((await run('SELECT 1 FROM ""', m)).parsed).toBe(false);

    const masked = await run('SELECT total, * FROM orders', m);
    const total = masked.identifiers.find((i) => i.text === 'total');
    expect(total?.status).toBe('unknown');
    expect(total?.messageCode).toBe('postgresql.query-unknown-column');
    expect(total?.suggestions).not.toContain('total');
    expect(masked.touchedFieldIds).not.toContain('fd_ord_total');
    expect(masked.touchedFieldIds.length).toBeGreaterThan(0);
    expect(masked.hiddenReferences).toEqual([]);
  });

  it('touches every visible field for `*`, deduped in first-appearance order', async () => {
    const result = await run('SELECT c.email, o.* FROM orders o JOIN customers c ON c.id = o.id, orders o2');
    expect(result.touchedFieldIds).toEqual(['fd_c_email', 'fd_o_id', 'fd_o_cust', 'fd_o_total', 'fd_c_id']);
    expect(result.touchedEntityIds).toEqual(['en_orders', 'en_customers']);
  });

  it('reports statement kinds and resolves DML targets', async () => {
    const result = await run(
      'INSERT INTO orders (id, nope) VALUES (1, 2); UPDATE orders SET total = 0 WHERE id = 1; ' +
        'DELETE FROM customers WHERE email IS NULL; CREATE TABLE fresh (a int CHECK (a > 0))',
    );
    expect(result.statementKinds).toEqual(['INSERT', 'UPDATE', 'DELETE', 'CREATE TABLE']);
    expect(result.identifiers.filter((i) => i.status === 'unknown').map((i) => i.text)).toEqual(['nope']);
    expect(result.identifiers.find((i) => i.text === 'fresh')?.status).toBe('unchecked');
  });

  it('returns parse errors with a range instead of throwing, and keeps the good statements', async () => {
    const query = 'SELECT id FROM orders; SELEC é FROM x; SELECT total FROM';
    const result = await run(query);
    expect(result.parsed).toBe(false);
    expect(result.parseErrors).toHaveLength(2);
    const [first, second] = result.parseErrors;
    expect(query.slice(first?.range.start, first?.range.end)).toBe('SELEC');
    expect(first?.range.column).toBe(24);
    expect(second?.range.end).toBe(query.length);
    expect(result.statementKinds).toEqual(['SELECT']);
    expect(result.touchedEntityIds).toEqual(['en_orders']);
  });

  it('maps byte offsets to UTF-16 offsets after multi-byte text', async () => {
    const query = "SELECT 'ünïcødé 🎉', email FROM customers";
    const result = await run(query);
    const email = result.identifiers.find((i) => i.text === 'email');
    expect(email?.status).toBe('resolved');
    expect(query.slice(email?.range.start, email?.range.end)).toBe('email');
  });

  it('marks functions unchecked and ignores a restrictedProbe', async () => {
    let probed = false;
    const result = await QUERY_VALIDATOR.validate({
      query: 'SELECT lower(email), pg_catalog.now() FROM secret_table, customers',
      model: MODEL,
      context,
      restrictedProbe: () => {
        probed = true;
        return 'hidden';
      },
    });
    expect(probed).toBe(false);
    expect(result.identifiers.filter((i) => i.role === 'function').map((i) => i.text)).toEqual([
      'lower',
      'pg_catalog.now',
    ]);
    expect(result.identifiers.find((i) => i.text === 'secret_table')?.status).toBe('unknown');
    // found on a known source, so it resolves even with an opaque one beside it
    expect(result.identifiers.find((i) => i.text === 'email')?.status).toBe('resolved');
    expect(result.hiddenReferences).toEqual([]);
  });
});
