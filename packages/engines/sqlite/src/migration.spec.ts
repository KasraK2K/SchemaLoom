import {
  renderMigrationScript,
  renderStatements,
  type ImportOptions,
  type SchemaModel,
} from '@schemaloom/engine-sdk';
import { diffModels } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import { annotateDiff } from './annotate.js';
import { buildExport } from './exporter.js';
import { IMPORTER, readModel } from './importer.js';
import { MIGRATION_GENERATOR } from './migration.js';
import { openMemory } from './sqlite.js';

/**
 * Phase 13 §7 — migrations checked on a real database: the old DDL applied, the generated
 * script run, the database read back, and it must be exactly the target design.
 */

const OPTIONS: ImportOptions = {
  format: 'ddl',
  defaultNamespace: '',
  caseFolding: 'preserve',
  engineOptions: {},
};

async function importSql(source: string, prefix = 'id'): Promise<SchemaModel> {
  let n = 0;
  const { model, report } = await IMPORTER.import(source, OPTIONS, {
    projectId: 'p1',
    serverVersion: '3.45',
    newId: () => `${prefix}${String(++n)}`,
  });
  expect(report.countsByStatus.failed).toBe(0);
  return model;
}

const ddl = (model: SchemaModel): string =>
  renderStatements(
    buildExport({
      model: { ...model, redacted: true } as never,
      options: {
        format: 'ddl',
        includeComments: false,
        includeDrops: false,
        includeIfNotExists: false,
        engineOptions: {},
      },
      context: { projectId: 'p1', serverVersion: '3.45' },
    }),
  );

/**
 * `after` with the ids of `before`'s objects of the same name, as a drift read pairs them
 * (`mergeImport`), so the diff holds only what really changed.
 */
function aligned(before: SchemaModel, after: SchemaModel): SchemaModel {
  interface Named {
    id: string;
    name: string;
    entityId?: string;
  }
  const owner = (m: SchemaModel, o: Named) =>
    o.entityId === undefined ? '' : (m.objects.entity[o.entityId]?.name ?? '');
  const byKey = new Map<string, string>();
  for (const [type, bag] of Object.entries(before.objects)) {
    for (const o of Object.values(bag as Record<string, Named>)) {
      byKey.set(`${type}:${owner(before, o)}:${o.name}`, o.id);
    }
  }
  const ids = new Map<string, string>();
  for (const [type, bag] of Object.entries(after.objects)) {
    for (const o of Object.values(bag as Record<string, Named>)) {
      const same = byKey.get(`${type}:${owner(after, o)}:${o.name}`);
      if (same !== undefined) ids.set(o.id, same);
    }
  }
  const renamed = JSON.parse(JSON.stringify(after), (_k, v: unknown) =>
    typeof v === 'string' ? (ids.get(v) ?? v) : v,
  ) as SchemaModel;
  // The maps are keyed by id too.
  const objects = Object.fromEntries(
    Object.entries(renamed.objects).map(([type, bag]) => [
      type,
      Object.fromEntries(
        Object.values(bag as Record<string, { id: string }>).map((o) => [o.id, o]),
      ),
    ]),
  ) as SchemaModel['objects'];
  return { ...renamed, objects };
}

async function migrate(
  beforeSql: string,
  target: string | ((before: SchemaModel) => SchemaModel),
  allowDestructive = true,
) {
  const before = await importSql(beforeSql);
  const after =
    typeof target === 'string' ? aligned(before, await importSql(target, 'new')) : target(before);
  const diff = annotateDiff(diffModels(before, after, { ignoreCosmetic: true }));
  const plan = await MIGRATION_GENERATOR.generate({
    diff,
    before,
    after,
    options: { allowDestructive, transactional: true, engineOptions: {} },
    context: { projectId: 'p1', serverVersion: '3.45' },
  });
  const script = renderMigrationScript(plan, { separator: ';', lineComment: '--' });
  const db = await openMemory();
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(ddl(before));
    db.exec("INSERT INTO customers (id, email) VALUES (1, 'a@b.c')");
    db.exec(script);
    let n = 0;
    const result = readModel(db, () => `r${String(++n)}`, '', 'p1', '3.45');
    if (allowDestructive) expect(ddl(result)).toBe(ddl(after));
    // The rows survive every rebuild.
    expect(db.all('SELECT email FROM customers')).toEqual([{ email: 'a@b.c' }]);
  } finally {
    db.close();
  }
  return { plan, script };
}

const BASE = `
CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL, note TEXT);
CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total INTEGER);
CREATE INDEX orders_total ON orders (total);
CREATE VIEW customer_emails AS SELECT id, email FROM customers;
`;

describe('sqlite migrations, run for real', () => {
  it('adds a nullable column with ALTER TABLE', async () => {
    const { plan } = await migrate(BASE, BASE.replace('note TEXT)', 'note TEXT, nickname TEXT)'));
    expect(plan.steps.map((s) => s.kind)).toEqual(['ALTER TABLE']);
    expect(plan.steps[0]?.text).toBe('ALTER TABLE "customers" ADD COLUMN "nickname" text');
  });

  it('renames a column with ALTER TABLE, keeping its data', async () => {
    const { plan } = await migrate(BASE, (before) => {
      const note = Object.values(before.objects.field).find((f) => f.name === 'note');
      if (note === undefined) throw new Error('fixture');
      return {
        ...before,
        objects: {
          ...before.objects,
          field: { ...before.objects.field, [note.id]: { ...note, name: 'remark' } },
        },
      };
    });
    expect(plan.steps.map((s) => s.text)).toEqual([
      'ALTER TABLE "customers" RENAME COLUMN "note" TO "remark"',
    ]);
  });

  it('rebuilds for a change ALTER TABLE cannot make, and puts back views and indexes', async () => {
    const { plan } = await migrate(
      BASE,
      BASE.replace('email TEXT NOT NULL', 'email TEXT NOT NULL UNIQUE').replace(
        'customer_id INTEGER,',
        'customer_id INTEGER REFERENCES customers (id) ON DELETE CASCADE,',
      ),
    );
    expect(plan.steps.map((s) => [s.kind, s.requiresTableRewrite, s.destructive])).toEqual([
      ['REBUILD TABLE', true, false],
      ['REBUILD TABLE', true, false],
    ]);
    expect(plan.transaction?.begin).toBe('PRAGMA foreign_keys = OFF;\nBEGIN');
  });

  it('flags a change of affinity as lossy', async () => {
    const { plan } = await migrate(BASE, BASE.replace('total INTEGER', 'total TEXT'));
    expect(plan.steps.map((s) => [s.kind, s.lossy, s.reasonCode])).toEqual([
      ['REBUILD TABLE', true, 'sqlite.migration-affinity'],
    ]);
  });

  it('drops a column with ALTER TABLE, or rebuilds when an index uses it; both are destructive', async () => {
    const plain = await migrate(BASE, BASE.replace(', note TEXT)', ')'));
    expect(plain.plan.steps.map((s) => [s.text, s.destructive])).toEqual([
      ['ALTER TABLE "customers" DROP COLUMN "note"', true],
    ]);
    const indexed = await migrate(
      BASE,
      BASE.replace(', total INTEGER)', ')').replace(
        'CREATE INDEX orders_total ON orders (total);',
        '',
      ),
    );
    expect(indexed.plan.steps.map((s) => [s.kind, s.destructive])).toEqual([
      ['REBUILD TABLE', true],
    ]);
    // Not allowed: the whole rebuild is commented out, nothing half-done.
    const guarded = await migrate(BASE, BASE.replace(', note TEXT)', ')'), false);
    expect(guarded.script).toContain('-- ALTER TABLE "customers" DROP COLUMN "note";');
  });

  it('creates and drops tables, indexes and views', async () => {
    const { plan } = await migrate(
      BASE,
      `${BASE.replace('CREATE INDEX orders_total ON orders (total);', 'CREATE INDEX orders_customer ON orders (customer_id);')}
CREATE TABLE tags (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
CREATE VIEW big_orders AS SELECT id FROM orders WHERE total > 100;`,
    );
    expect(plan.steps.map((s) => s.kind).sort()).toEqual([
      'CREATE INDEX',
      'CREATE TABLE',
      'CREATE VIEW',
      'DROP INDEX',
    ]);
  });
});
