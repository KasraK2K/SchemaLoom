import { describe, expect, it } from 'vitest';
import { byId, entity, field, index, model, namespace } from '../fixtures.js';
import type { SchemaModel } from '../model.js';
import { diffModels, isEmptyDiff } from './index.js';
import { threeWay } from './three-way.js';

const base = (): SchemaModel =>
  model({
    namespace: byId([namespace('ns1', 'public')]),
    entity: byId([entity('e1', 'orders', 'ns1'), entity('e2', 'customers', 'ns1')]),
    field: byId([field('f1', 'id', 'e1'), field('f2', 'id', 'e2')]),
  });

type Edit = (m: SchemaModel) => void;
const edited = (...edits: Edit[]): SchemaModel => {
  const m = structuredClone(base());
  for (const e of edits) e(m);
  return m;
};
const rename =
  (id: string, name: string): Edit =>
  (m) => {
    const e = m.objects.entity[id];
    if (e !== undefined) m.objects.entity[id] = { ...e, name, version: e.version + 1 };
  };
const addField =
  (id: string, entityId: string): Edit =>
  (m) => {
    m.objects.field[id] = field(id, id, entityId);
  };
const dropEntity =
  (id: string): Edit =>
  (m) => {
    m.objects.entity = Object.fromEntries(
      Object.entries(m.objects.entity).filter(([key]) => key !== id),
    );
    m.objects.field = Object.fromEntries(
      Object.entries(m.objects.field).filter(([, f]) => f.entityId !== id),
    );
  };
const move =
  (id: string, x: number): Edit =>
  (m) => {
    const e = m.objects.entity[id];
    if (e !== undefined) m.objects.entity[id] = { ...e, position: { x, y: 0 } };
  };

const same = (a: SchemaModel, b: SchemaModel): boolean =>
  isEmptyDiff(diffModels(a, b, { ignoreCosmetic: true }));

describe('threeWay', () => {
  it('is theirs when ours did not move from base', () => {
    const theirs = edited(rename('e1', 'purchases'), addField('f9', 'e1'));
    const out = threeWay(base(), base(), theirs);
    expect(out.conflicts).toEqual([]);
    expect(out.taken).toBe(2);
    expect(same(out.merged, theirs)).toBe(true);
  });

  it('keeps both sides when they touched different objects', () => {
    const ours = edited(rename('e2', 'clients'));
    const theirs = edited(rename('e1', 'purchases'));
    const out = threeWay(base(), ours, theirs);
    expect(out.conflicts).toEqual([]);
    expect(out.merged.objects.entity.e1?.name).toBe('purchases');
    expect(out.merged.objects.entity.e2?.name).toBe('clients');
  });

  it('reports an object both sides changed, and keeps ours by default', () => {
    const out = threeWay(base(), edited(rename('e1', 'a')), edited(rename('e1', 'b')));
    expect(out.conflicts).toEqual([{ type: 'entity', id: 'e1', reason: 'both_changed' }]);
    expect(out.merged.objects.entity.e1?.name).toBe('a');
  });

  it('takes theirs on a conflict when asked (update from main)', () => {
    const out = threeWay(base(), edited(rename('e1', 'a')), edited(rename('e1', 'b')), {
      prefer: 'theirs',
    });
    expect(out.conflicts).toHaveLength(1);
    expect(out.merged.objects.entity.e1?.name).toBe('b');
  });

  it('is no conflict when both sides made the same edit', () => {
    const out = threeWay(base(), edited(rename('e1', 'x')), edited(rename('e1', 'x')));
    expect(out.conflicts).toEqual([]);
    expect(out.taken).toBe(0);
  });

  it('conflicts on a delete against an edit, in both directions', () => {
    const deleteVsEdit = threeWay(base(), edited(dropEntity('e2')), edited(rename('e2', 'x')));
    expect(deleteVsEdit.conflicts).toContainEqual({
      type: 'entity',
      id: 'e2',
      reason: 'both_changed',
    });
    const editVsDelete = threeWay(base(), edited(rename('e2', 'x')), edited(dropEntity('e2')));
    expect(editVsDelete.conflicts).toContainEqual({
      type: 'entity',
      id: 'e2',
      reason: 'both_changed',
    });
  });

  it('reports a column added to a table the other side deleted', () => {
    const out = threeWay(base(), edited(dropEntity('e2')), edited(addField('f9', 'e2')));
    expect(out.conflicts).toEqual([{ type: 'field', id: 'f9', reason: 'DANGLING_REFERENCE' }]);
  });

  it('drops what no longer fits when preferring theirs, cascading', () => {
    const draft = edited(addField('f9', 'e2'), (m) => {
      m.objects.index.i9 = index('i9', 'idx', 'e2', {
        columns: [{ ordinal: 0, fieldId: 'f9', expression: null, role: 'key', engineProps: {} }],
      });
    });
    const out = threeWay(base(), draft, edited(dropEntity('e2')), { prefer: 'theirs' });
    expect(out.merged.objects.field.f9).toBeUndefined();
    expect(out.merged.objects.entity.e2).toBeUndefined();
    expect(out.conflicts.map((c) => c.id)).toContain('f9');
  });

  it('does not merge layout of an existing table, and keeps a new table where it was drawn', () => {
    const theirs = edited(move('e1', 500), (m) => {
      m.objects.entity.e9 = entity('e9', 'invoices', 'ns1', { position: { x: 900, y: 0 } });
    });
    const out = threeWay(base(), base(), theirs);
    expect(out.merged.objects.entity.e1?.position).toEqual({ x: 0, y: 0 });
    expect(out.merged.objects.entity.e9?.position).toEqual({ x: 900, y: 0 });
    expect(out.taken).toBe(1);
  });

  it('keeps ours’ layout when it takes theirs’ edit', () => {
    const out = threeWay(base(), edited(move('e1', 300)), edited(rename('e1', 'purchases')));
    expect(out.conflicts).toEqual([]);
    expect(out.merged.objects.entity.e1).toMatchObject({
      name: 'purchases',
      position: { x: 300, y: 0 },
    });
  });
});
