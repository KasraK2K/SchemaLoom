import { emptyCollections, type SchemaModel } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import { freshIds, invertIds, remapIds } from './change-request-ids';

// The remap is a generic walk, so a hand-built model with real reference shapes is enough.
const main = {
  irVersion: 1,
  projectId: 'prj_main',
  engineId: 'postgresql',
  engineVersion: '16',
  redacted: false,
  objects: {
    ...emptyCollections(),
    namespace: { ns1: { id: 'ns1', name: 'public' } },
    entity: {
      e1: { id: 'e1', name: 'orders', namespaceId: 'ns1' },
      e2: { id: 'e2', name: 'customers', namespaceId: 'ns1' },
    },
    field: {
      f1: { id: 'f1', name: 'id', entityId: 'e1' },
      f2: { id: 'f2', name: 'customer_id', entityId: 'e1' },
      f3: { id: 'f3', name: 'id', entityId: 'e2' },
    },
    link: {
      l1: {
        id: 'l1',
        name: 'fk',
        from: { entityId: 'e1', fieldIds: ['f2'] },
        to: { entityId: 'e2', fieldIds: ['f3'] },
      },
    },
  },
} as unknown as SchemaModel;

describe('change request id maps', () => {
  let n = 0;
  const toDraft = freshIds(main, {}, () => `d${String(++n)}`);

  it('gives every object a fresh id', () => {
    expect(Object.keys(toDraft).sort()).toEqual(['e1', 'e2', 'f1', 'f2', 'f3', 'l1', 'ns1']);
  });

  it('moves every reference with its object, and round-trips', () => {
    const draft = remapIds(main, toDraft, 'prj_draft');
    const l = Object.values(draft.objects.link)[0];
    expect(l?.from.entityId).toBe(toDraft.e1);
    expect(l?.to.fieldIds).toEqual([toDraft.f3]);
    expect(draft.objects.field[toDraft.f2 ?? '']?.entityId).toBe(toDraft.e1);
    // a name that happens to read like a word is untouched
    expect(draft.objects.field[toDraft.f1 ?? '']?.name).toBe('id');

    const back = remapIds(draft, invertIds(toDraft), main.projectId);
    expect(back).toEqual(main);
  });

  it('only mints ids the map does not already have', () => {
    expect(
      freshIds(main, { e1: 'x', e2: 'y', f1: 'a', f2: 'b', f3: 'c', l1: 'l', ns1: 'n' }, () => 'z'),
    ).toEqual({});
  });
});
