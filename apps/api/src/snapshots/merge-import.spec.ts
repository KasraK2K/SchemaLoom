import { diffModels, type SchemaModel } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import {
  baseStore,
  constraintColumnRow,
  constraintRow,
  entityRow,
  fieldRow,
} from '../schema/fixture';
import { mergeImport, withDesignOnly, withSameViewBodies } from './merge-import';
import { planImport } from './restore-plan';
import { liveFrom } from './test-fixture';

/** An importer's model: same names, its OWN ids (prefix `i_`), its own default namespace. */
async function importedFrom(store: Parameters<typeof liveFrom>[0]): Promise<SchemaModel> {
  const model = await liveFrom(store);
  return JSON.parse(
    JSON.stringify(model).replace(/"(ns_public|ent_\w+|fld_\w+|con_\w+)"/g, '"i_$1"'),
  ) as SchemaModel;
}

let n = 0;
const ids = () => `b${String(++n)}`;

describe('drift against an unchanged database', () => {
  it('is empty when only SchemaLoom-side attributes and the custom-type null differ', async () => {
    const store = baseStore({
      entity: [entityRow('ent_orders', { name: 'orders' })],
      field: [fieldRow('fld_id', 'ent_orders', { name: 'id', position: 0, isPii: true })],
    });
    const live = await liveFrom(store);
    // What a database read looks like: no PII flag, no doc, no customTypeId key at all.
    const read = await importedFrom(store);
    const field = read.objects.field.i_fld_id;
    if (field === undefined) throw new Error('fixture');
    const { customTypeId: _absent, ...type } = field.type;
    (read.objects.field as Record<string, unknown>).i_fld_id = { ...field, isPii: false, type };

    const database = withDesignOnly(mergeImport(live, read).imported, live);
    expect(diffModels(database, live, { ignoreCosmetic: true }).entries).toEqual([]);
    // Without the copy, the PII flag alone is drift.
    expect(diffModels(mergeImport(live, read).imported, live).entries).toHaveLength(1);
  });

  it('takes the design’s view text when the engine calls the bodies the same query', async () => {
    const view = (body: string) =>
      baseStore({
        entity: [
          entityRow('ent_v', { name: 'v', kind: 'view', engineProps: { viewDefinition: body } }),
        ],
      });
    const live = await liveFrom(view('select id from orders'));
    const read = await importedFrom(view('SELECT id FROM public.orders;'));
    const database = withDesignOnly(mergeImport(live, read).imported, live);
    const drift = async (same?: (a: string, b: string) => Promise<boolean>) =>
      diffModels(await withSameViewBodies(database, live, same), live, { ignoreCosmetic: true })
        .entries;

    expect(await drift()).toHaveLength(1);
    expect(await drift(() => Promise.resolve(false))).toHaveLength(1);
    expect(await drift(() => Promise.resolve(true))).toEqual([]);
  });

  it('tells the engine each relation’s columns in the database read', async () => {
    const store = baseStore({
      entity: [
        entityRow('ent_orders', { name: 'Orders' }),
        entityRow('ent_v', { name: 'v', kind: 'view', engineProps: { viewDefinition: 'a' } }),
      ],
      field: [
        fieldRow('fld_id', 'ent_orders', { name: 'id', position: 0 }),
        fieldRow('fld_total', 'ent_orders', { name: 'total', position: 1 }),
      ],
    });
    const live = await liveFrom(store);
    const read = await importedFrom(store);
    (read.objects.entity as Record<string, { engineProps: object }>).i_ent_v = {
      ...read.objects.entity.i_ent_v!,
      engineProps: { viewDefinition: 'b' },
    };
    const database = withDesignOnly(mergeImport(live, read).imported, live);
    let seen: ((relation: string) => readonly string[] | undefined) | undefined;
    await withSameViewBodies(database, live, (_a, _b, columns) => {
      seen = columns;
      return Promise.resolve(false);
    });

    expect(seen?.('orders')).toEqual(['id', 'total']);
    expect(seen?.('missing')).toBeUndefined();
  });
});

describe('mergeImport', () => {
  it('adds new tables and new columns, and retargets them onto existing ids', async () => {
    const live = await liveFrom(
      baseStore({
        entity: [entityRow('ent_orders', { name: 'orders' })],
        field: [fieldRow('fld_id', 'ent_orders', { name: 'id', position: 0 })],
      }),
    );
    const imported = await importedFrom(
      baseStore({
        entity: [
          entityRow('ent_orders', { name: 'orders' }),
          entityRow('ent_users', { name: 'users' }),
        ],
        field: [
          fieldRow('fld_id', 'ent_orders', { name: 'id', position: 0 }),
          fieldRow('fld_total', 'ent_orders', { name: 'total', position: 1 }),
        ],
      }),
    );

    const merged = mergeImport(live, imported);
    const [batch] = planImport(live, merged.model, ids, 'Import SQL');

    expect(merged.existing).toEqual(['orders']);
    expect(batch?.ops.every((op) => op.op === 'create')).toBe(true);
    expect(batch?.ops.map((op) => (op.op === 'create' ? op.object.id : null))).toEqual([
      'i_ent_users',
      'i_fld_total',
    ]);
    const total = merged.model.objects.field.i_fld_total;
    expect(total?.entityId).toBe('ent_orders');
    expect(total?.ordinal).toBe(2);
    expect(merged.model.objects.entity.i_ent_users?.namespaceId).toBe('ns_public');
  });

  it('never plans a delete for a table the source does not mention', async () => {
    const live = await liveFrom(baseStore({ entity: [entityRow('ent_keep', { name: 'keep' })] }));
    const imported = await importedFrom(
      baseStore({ entity: [entityRow('ent_new', { name: 'new' })] }),
    );

    const ops = planImport(live, mergeImport(live, imported).model, ids, 'Import SQL').flatMap(
      (b) => b.ops,
    );
    expect(ops.map((op) => op.op)).toEqual(['create']);
  });

  it('skips a second primary key on a table that already has one', async () => {
    const pk = (id: string, field: string) => ({
      constraint: [constraintRow(id, 'ent_t', { name: '' })],
      constraintColumn: [constraintColumnRow(id, field)],
    });
    const live = await liveFrom(
      baseStore({
        entity: [entityRow('ent_t', { name: 't' })],
        field: [fieldRow('fld_a', 'ent_t', { name: 'a' })],
        ...pk('con_pk', 'fld_a'),
      }),
    );
    const imported = await importedFrom(
      baseStore({
        entity: [entityRow('ent_t', { name: 't' })],
        field: [
          fieldRow('fld_a', 'ent_t', { name: 'a' }),
          fieldRow('fld_b', 'ent_t', { name: 'b' }),
        ],
        ...pk('con_pk', 'fld_b'),
      }),
    );

    expect(Object.keys(mergeImport(live, imported).model.objects.constraint)).toEqual(['con_pk']);
  });

  it('splits an import over the per-batch op cap into dependency-ordered batches', async () => {
    const live = await liveFrom(baseStore({}));
    const entity = Array.from({ length: 1500 }, (_, i) => entityRow(`ent_${String(i)}`));
    const field = entity.map((e, i) => fieldRow(`fld_${String(i)}`, e.id as string));
    const imported = await importedFrom(baseStore({ entity, field }));

    const batches = planImport(live, mergeImport(live, imported).model, ids, 'Import SQL');

    expect(batches.map((b) => b.ops.length)).toEqual([2000, 1000]);
    const types = batches.flatMap((b) => b.ops.map((op) => (op.op === 'create' ? op.type : '')));
    expect(types.lastIndexOf('entity')).toBeLessThan(types.indexOf('field'));
  });
});
