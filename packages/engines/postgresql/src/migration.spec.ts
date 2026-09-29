import { renderMigrationScript, type MigrationPlan, type SchemaModel } from '@schemaloom/engine-sdk';
import { diffModels } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import { annotateDiff, typeChangeRisk } from './annotate.js';
import { CONFORMANCE_FIXTURES, referenceModel } from './conformance-fixtures.js';
import { column, customType, model, table } from './fixture-model.js';
import { MIGRATION_GENERATOR } from './migration.js';

/**
 * Doc 03 §11.2, from the side the conformance suite cannot reach: the suite asserts the
 * guarantees over any engine's fixtures; this file asserts the SQL PostgreSQL needs.
 */

async function migrate(before: SchemaModel, after: SchemaModel, allowDestructive = false): Promise<MigrationPlan> {
  const diff = annotateDiff(diffModels(before, after, { ignoreCosmetic: true }), before, after);
  return MIGRATION_GENERATOR.generate({
    diff,
    before,
    after,
    options: { allowDestructive, transactional: false, engineOptions: {} },
    context: { projectId: 'p1', serverVersion: '16' },
  });
}

const texts = (plan: MigrationPlan): string[] => plan.steps.map((s) => s.text);
const pair = (name: string) => {
  const found = CONFORMANCE_FIXTURES.migrations.find((m) => m.name === name);
  if (found === undefined) throw new Error(name);
  return found;
};

function empty(): SchemaModel {
  return model({ namespaces: [] });
}

describe('the fixture pairs', () => {
  it('adds a column, then its index', async () => {
    const { before, after } = pair('add a column and an index');
    expect(texts(await migrate(before, after))).toEqual([
      'ALTER TABLE public.customers ADD COLUMN nickname text',
      'CREATE INDEX customers_nickname_idx ON public.customers USING btree (nickname)',
    ]);
  });

  it('comments a DROP COLUMN out unless destructive steps are allowed', async () => {
    const { before, after } = pair('drop a column');
    const guarded = await migrate(before, after);
    expect(guarded.steps).toMatchObject([
      { text: 'ALTER TABLE public.customers DROP COLUMN created_at', destructive: true, commentedOut: true },
    ]);
    expect(renderMigrationScript(guarded, { separator: ';', lineComment: '--' })).toContain(
      '-- ALTER TABLE public.customers DROP COLUMN created_at;',
    );
    expect((await migrate(before, after, true)).steps[0]?.commentedOut).toBe(false);
  });

  it('marks a narrowed type lossy and NOT NULL as a locking scan', async () => {
    const { before, after } = pair('narrow a varchar and require a value');
    const plan = await migrate(before, after);
    expect(plan.steps).toMatchObject([
      {
        text: 'ALTER TABLE public.customers ALTER COLUMN email TYPE varchar(64) USING email::varchar(64)',
        lossy: true,
        destructive: false,
        reasonCode: 'postgresql.migration-type-narrowed',
      },
      {
        text: 'ALTER TABLE public.orders ALTER COLUMN customer_id SET NOT NULL',
        requiresTableRewrite: true,
        reasonCode: 'postgresql.migration-not-null',
      },
    ]);
  });

  it('renames the schema, then the table, then the column at the new table name', async () => {
    const { before, after } = pair('rename a table, a column and a schema');
    expect(texts(await migrate(before, after))).toEqual([
      'ALTER SCHEMA billing RENAME TO finance',
      'ALTER TABLE public.customers RENAME TO clients',
      'ALTER TABLE public.clients RENAME COLUMN email TO email_address',
    ]);
  });
});

describe('whole-model scripts', () => {
  it('drops foreign keys before the tables, views before tables, types and schemas last', async () => {
    const plan = await migrate(referenceModel(), empty(), true);
    expect(texts(plan)).toEqual([
      'ALTER TABLE public.orders DROP CONSTRAINT orders_customer_id_fkey',
      'DROP MATERIALIZED VIEW billing.order_stats',
      'DROP VIEW billing.order_summary',
      'DROP TABLE public.customers',
      'DROP TABLE public.orders',
      'DROP TYPE public.order_status',
      'DROP DOMAIN public.positive_int',
      'DROP SCHEMA billing',
      'DROP SCHEMA public',
    ]);
    expect(plan.unsupported).toEqual([]);
  });

  it('creates types before the tables that use them and foreign keys last', async () => {
    const steps = texts(await migrate(empty(), referenceModel()));
    const at = (prefix: string) => steps.findIndex((s) => s.startsWith(prefix));
    expect(at('CREATE TYPE public.order_status')).toBeLessThan(at('CREATE TABLE public.orders'));
    expect(at('CREATE TABLE public.orders')).toBeLessThan(at('CREATE VIEW billing.order_summary'));
    expect(steps.at(-1)).toMatch(/FOREIGN KEY/);
  });
});

describe('custom types', () => {
  const withLabels = (labels: string[]) =>
    model({
      customTypes: [customType({ id: 'ct', name: 'mood', namespaceId: 'public', engineProps: { labels } })],
    });

  it('appends an enum label with ADD VALUE', async () => {
    expect(texts(await migrate(withLabels(['a', 'b']), withLabels(['a', 'x', 'b'])))).toEqual([
      "ALTER TYPE public.mood ADD VALUE 'x' AFTER 'a'",
    ]);
  });

  it('refuses to remove a label, and annotates the removal destructive', async () => {
    const before = withLabels(['a', 'b']);
    const after = withLabels(['a']);
    const plan = await migrate(before, after);
    expect(plan.steps).toEqual([]);
    expect(plan.unsupported).toMatchObject([{ entry: { type: 'customType', id: 'ct' } }]);
    const diff = annotateDiff(diffModels(before, after), before, after);
    expect(diff.summary.destructive).toBe(1);
  });

  it('lets a type rename carry its columns: no ALTER COLUMN TYPE', async () => {
    const build = (name: string) =>
      model({
        customTypes: [customType({ id: 'ct', name, namespaceId: 'public', engineProps: { labels: ['a'] } })],
        entities: [table({ id: 't', name: 't', namespaceId: 'public' })],
        fields: [column({ id: 'c', name: 'c', entityId: 't', type: { name, customTypeId: 'ct' } })],
      });
    const plan = await migrate(build('mood'), build('feeling'));
    expect(texts(plan)).toEqual(['ALTER TYPE public.mood RENAME TO feeling']);
    expect(plan.steps[0]?.covers).toEqual([
      { type: 'customType', id: 'ct' },
      { type: 'field', id: 'c' },
    ]);
  });
});

describe('columns', () => {
  const tableWith = (names: string[]) =>
    model({
      entities: [table({ id: 't', name: 't', namespaceId: 'public' })],
      fields: names.map((n, ordinal) => column({ id: `f_${n}`, name: n, entityId: 't', ordinal })),
    });

  it('covers the siblings a DROP COLUMN renumbers', async () => {
    const plan = await migrate(tableWith(['a', 'b', 'c']), tableWith(['a', 'c']), true);
    expect(texts(plan)).toEqual(['ALTER TABLE public.t DROP COLUMN b']);
    expect(plan.steps[0]?.covers).toContainEqual({ type: 'field', id: 'f_c' });
    expect(plan.unsupported).toEqual([]);
  });

  it('lists a real reorder as a manual step', async () => {
    const plan = await migrate(tableWith(['a', 'b']), tableWith(['b', 'a']));
    expect(plan.steps).toEqual([]);
    expect(plan.unsupported.map((u) => u.entry.id).sort()).toEqual(['f_a', 'f_b']);
  });

  it('recreates a view whose definition changed', async () => {
    const view = (sql: string) =>
      model({ entities: [table({ id: 'v', name: 'v', namespaceId: 'public', kind: 'view', engineProps: { viewDefinition: sql } })] });
    expect(texts(await migrate(view('SELECT 1'), view('SELECT 2')))).toEqual([
      'DROP VIEW public.v',
      'CREATE VIEW public.v AS SELECT 2',
    ]);
  });
});

describe('typeChangeRisk', () => {
  const risk = (from: { name: string; args?: number[] }, to: { name: string; args?: number[] }) => {
    const m = (type: typeof from) =>
      model({ entities: [table({ id: 't', namespaceId: 'public' })], fields: [column({ id: 'c', entityId: 't', type })] });
    const b = m(from);
    const a = m(to);
    const bf = b.objects.field.c;
    const af = a.objects.field.c;
    if (bf === undefined || af === undefined) throw new Error('fixture');
    return typeChangeRisk(b, bf, a, af);
  };

  it.each([
    [{ name: 'integer' }, { name: 'bigint' }, false, true],
    [{ name: 'varchar', args: [10] }, { name: 'varchar', args: [20] }, false, false],
    [{ name: 'varchar', args: [10] }, { name: 'text' }, false, false],
    [{ name: 'varchar', args: [20] }, { name: 'varchar', args: [10] }, true, true],
    [{ name: 'numeric', args: [10, 2] }, { name: 'numeric', args: [10, 0] }, true, true],
    [{ name: 'bigint' }, { name: 'integer' }, true, true],
    [{ name: 'text' }, { name: 'integer' }, true, true],
  ])('%o -> %o: lossy %s, rewrite %s', (from, to, lossy, rewrite) => {
    expect(risk(from, to)).toMatchObject({ lossy, requiresTableRewrite: rewrite });
  });

  it('treats an alias spelling as no change', () => {
    expect(risk({ name: 'int4' }, { name: 'integer' })).toMatchObject({ same: true, lossy: false });
  });
});
