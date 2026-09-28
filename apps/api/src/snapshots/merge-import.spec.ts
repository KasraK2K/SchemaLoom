import type { SchemaModel } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import { baseStore, constraintColumnRow, constraintRow, entityRow, fieldRow } from '../schema/fixture';
import { mergeImport } from './merge-import';
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

describe('mergeImport', () => {
  it('adds new tables and new columns, and retargets them onto existing ids', async () => {
    const live = await liveFrom(baseStore({
      entity: [entityRow('ent_orders', { name: 'orders' })],
      field: [fieldRow('fld_id', 'ent_orders', { name: 'id', position: 0 })],
    }));
    const imported = await importedFrom(baseStore({
      entity: [
        entityRow('ent_orders', { name: 'orders' }),
        entityRow('ent_users', { name: 'users' }),
      ],
      field: [
        fieldRow('fld_id', 'ent_orders', { name: 'id', position: 0 }),
        fieldRow('fld_total', 'ent_orders', { name: 'total', position: 1 }),
      ],
    }));

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
    const imported = await importedFrom(baseStore({ entity: [entityRow('ent_new', { name: 'new' })] }));

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
    const live = await liveFrom(baseStore({
      entity: [entityRow('ent_t', { name: 't' })],
      field: [fieldRow('fld_a', 'ent_t', { name: 'a' })],
      ...pk('con_pk', 'fld_a'),
    }));
    const imported = await importedFrom(baseStore({
      entity: [entityRow('ent_t', { name: 't' })],
      field: [fieldRow('fld_a', 'ent_t', { name: 'a' }), fieldRow('fld_b', 'ent_t', { name: 'b' })],
      ...pk('con_pk', 'fld_b'),
    }));

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
