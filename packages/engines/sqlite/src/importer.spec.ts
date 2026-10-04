import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImportOptions, SchemaModel } from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import { IMPORTER } from './importer.js';

/** Phase 13 §7 — the importer: SQLite's own reading, and the allowlist. */

const OPTIONS: ImportOptions = {
  format: 'ddl',
  defaultNamespace: '',
  caseFolding: 'preserve',
  engineOptions: {},
};

async function importSql(source: string) {
  let n = 0;
  return IMPORTER.import(source, OPTIONS, {
    projectId: 'p1',
    serverVersion: '3.45',
    newId: () => `id${String(++n)}`,
  });
}

const SHOP = `
PRAGMA foreign_keys = ON;
BEGIN TRANSACTION;
CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email varchar(255) NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed'))
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers ON DELETE CASCADE,
  total numeric(10, 2) NOT NULL DEFAULT 0,
  net numeric(10, 2) GENERATED ALWAYS AS (total * (1 - 0.2)) STORED,
  placed_at datetime DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT orders_total_positive CHECK ((total >= 0) AND (net <= total))
);
CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT NOT NULL) STRICT, WITHOUT ROWID;
CREATE INDEX orders_by_customer ON orders (customer_id, placed_at DESC) WHERE total > 0;
CREATE INDEX orders_lower ON orders (lower(placed_at));
CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 100;
CREATE TRIGGER audit AFTER INSERT ON orders BEGIN SELECT 1; SELECT 2; END;
INSERT INTO customers (email) VALUES ('a@b.c');
COMMIT;
`;

const byName = (model: SchemaModel, name: string) =>
  Object.values(model.objects.entity).find((e) => e.name === name);
const fieldsOf = (model: SchemaModel, entityId: string) =>
  Object.values(model.objects.field).filter((f) => f.entityId === entityId);

describe('sqlite importer', () => {
  it('reads tables, keys, checks, generated columns, indexes, views', async () => {
    const { model, report } = await importSql(SHOP);
    expect(report.statements.map((s) => [s.kind, s.status])).toEqual([
      ['PRAGMA', 'ignored'],
      ['BEGIN', 'ignored'],
      ['CREATE TABLE', 'applied'],
      ['CREATE TABLE', 'applied'],
      ['CREATE TABLE', 'applied'],
      ['CREATE INDEX', 'applied'],
      ['CREATE INDEX', 'applied'],
      ['CREATE VIEW', 'applied'],
      ['CREATE TRIGGER', 'unsupported'],
      ['INSERT', 'ignored'],
      ['COMMIT', 'ignored'],
    ]);

    const customers = byName(model, 'customers');
    const orders = byName(model, 'orders');
    if (customers === undefined || orders === undefined) throw new Error('tables');
    expect(orders.engineProps).toEqual({});
    expect(byName(model, 'tags')?.engineProps).toEqual({ withoutRowid: true, strict: true });
    expect(
      fieldsOf(model, customers.id).map((f) => [f.name, f.type.name, f.isNullable, f.engineProps]),
    ).toEqual([
      ['id', 'integer', true, { autoIncrement: true }],
      ['email', 'varchar', false, { collation: 'NOCASE' }],
      ['status', 'text', false, { default: "'active'" }],
    ]);
    const net = fieldsOf(model, orders.id).find((f) => f.name === 'net');
    expect(net?.engineProps).toEqual({
      generatedExpression: 'total * (1 - 0.2)',
      generatedKind: 'STORED',
    });
    expect(fieldsOf(model, orders.id).find((f) => f.name === 'total')?.type).toMatchObject({
      name: 'numeric',
      args: [10, 2],
    });

    const constraints = Object.values(model.objects.constraint).map((c) => [
      c.kind,
      c.name,
      c.engineProps.expression ?? null,
    ]);
    expect(constraints).toEqual(
      expect.arrayContaining([
        ['primaryKey', 'customers_pkey', null],
        ['unique', 'customers_email_key', null],
        ['check', 'customers_status_check', "status IN ('active', 'closed')"],
        ['primaryKey', 'orders_pkey', null],
        ['check', 'orders_total_positive', '(total >= 0) AND (net <= total)'],
      ]),
    );

    const [fk] = Object.values(model.objects.link);
    expect(fk).toMatchObject({
      name: 'orders_customer_id_fkey',
      engineProps: { onDelete: 'cascade', onUpdate: 'noAction' },
      to: { entityId: customers.id },
    });

    const indexes = Object.values(model.objects.index).sort((a, b) => (a.name < b.name ? -1 : 1));
    expect(
      indexes.map((i) => [
        i.name,
        i.engineProps,
        i.columns.map((c) => [c.expression, c.direction]),
      ]),
    ).toEqual([
      [
        'orders_by_customer',
        { where: 'total > 0' },
        [
          [null, 'asc'],
          [null, 'desc'],
        ],
      ],
      ['orders_lower', {}, [['lower(placed_at)', 'asc']]],
    ]);

    expect(byName(model, 'big_orders')).toMatchObject({
      kind: 'view',
      engineProps: { viewDefinition: 'SELECT id, total FROM orders WHERE total > 100' },
    });
    // The report points every applied statement at what it made.
    expect(report.statements[2]?.producedObjects).toContainEqual({
      type: 'entity',
      id: customers.id,
    });
  });

  it('never runs what is outside the allowlist: ATTACH leaves no file behind', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sl-sqlite-'));
    const file = join(dir, 'attached.db').replace(/\\/g, '/');
    const { report } = await importSql(
      `ATTACH DATABASE '${file}' AS x;\nVACUUM INTO '${file}';\nCREATE TABLE t (a int);\nCREATE TABLE u AS SELECT * FROM t;`,
    );
    expect(report.statements.map((s) => [s.kind, s.status])).toEqual([
      ['ATTACH DATABASE', 'failed'],
      ['VACUUM INTO', 'failed'],
      ['CREATE TABLE', 'applied'],
      ['CREATE TABLE', 'unsupported'],
    ]);
    expect(existsSync(file)).toBe(false);
  });

  it("reports SQLite's own error for a statement it rejects", async () => {
    const { report } = await importSql('CREATE TABLE t (a int);\nCREATE INDEX i ON nope (a);');
    expect(report.statements[1]).toMatchObject({ status: 'failed' });
    expect(report.statements[1]?.reason).toContain('no such table');
  });
});

describe('sqlite DDL round trip', () => {
  it('exports what it imported, and reads its own export back unchanged', async () => {
    const { EXPORTER } = await import('./exporter.js');
    const { renderStatements } = await import('@schemaloom/engine-sdk');
    const exportOf = async (model: SchemaModel) =>
      renderStatements(
        await EXPORTER.export({
          model: { ...model, redacted: true } as never,
          options: {
            format: 'ddl',
            includeComments: true,
            includeDrops: false,
            includeIfNotExists: false,
            engineOptions: {},
          },
          context: { projectId: 'p1', serverVersion: '3.45' },
        }),
      );
    const first = await exportOf((await importSql(SHOP)).model);
    const again = await importSql(first);
    expect(again.report.countsByStatus.failed).toBe(0);
    expect(await exportOf(again.model)).toBe(first);
    expect(first).toMatchSnapshot();
  });
});
