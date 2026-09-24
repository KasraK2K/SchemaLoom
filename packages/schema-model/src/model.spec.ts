import { describe, expect, it } from 'vitest';

import * as f from './fixtures.js';
import {
  IR_OBJECT_SCHEMAS,
  IR_OBJECT_TYPES,
  SchemaModelSchema,
  emptyCollections,
  type IrCollections,
} from './model.js';

describe('IR_OBJECT_TYPES', () => {
  it('lists every object type exactly once', () => {
    expect([...IR_OBJECT_TYPES].sort()).toEqual(Object.keys(IR_OBJECT_SCHEMAS).sort());
    expect(new Set(IR_OBJECT_TYPES).size).toBe(IR_OBJECT_TYPES.length);
  });

  it('is in dependency order — a field after its entity, a link after both', () => {
    const rank = (t: string): number => IR_OBJECT_TYPES.indexOf(t as never);
    expect(rank('namespace')).toBeLessThan(rank('entity'));
    expect(rank('entity')).toBeLessThan(rank('field'));
    expect(rank('field')).toBeLessThan(rank('link'));
    expect(rank('customType')).toBeLessThan(rank('field'));
  });
});

describe('SchemaModel', () => {
  it('accepts an empty model', () => {
    expect(SchemaModelSchema.safeParse(f.model()).success).toBe(true);
  });

  it('keys collections by the SINGULAR type name (§1.3)', () => {
    const parsed = SchemaModelSchema.parse(
      f.model({ entity: f.byId([f.entity('e1', 'orders', 'n1')]) }),
    );
    expect(parsed.objects.entity.e1?.name).toBe('orders');
    expect(Object.keys(parsed.objects).sort()).toEqual([...IR_OBJECT_TYPES].sort());
  });

  it('round-trips a populated model', () => {
    const populated = f.model({
      namespace: f.byId([f.namespace('n1', 'public', { isDefault: true })]),
      entity: f.byId([f.entity('e1', 'orders', 'n1')]),
      field: f.byId([
        f.field('fl1', 'id', 'e1'),
        f.field('fl2', 'lat', 'e1', { parentFieldId: 'fl1', ordinal: 1 }),
      ]),
    });
    const parsed = SchemaModelSchema.parse(populated);
    expect(parsed).toEqual(populated);
    expect(SchemaModelSchema.parse(parsed)).toEqual(populated);
  });

  it('rejects an irVersion other than 1 — a loader must be able to say "upgrade it"', () => {
    expect(SchemaModelSchema.safeParse({ ...f.model(), irVersion: 2 }).success).toBe(false);
  });

  it('rejects an empty engineId — every project resolves an engine', () => {
    expect(SchemaModelSchema.safeParse({ ...f.model(), engineId: '' }).success).toBe(false);
  });

  it('rejects a missing collection — the container is always fully populated', () => {
    const { link: _drop, ...objects } = emptyCollections();
    expect(SchemaModelSchema.safeParse({ ...f.model(), objects }).success).toBe(false);
  });

  it('rejects a structurally invalid object inside a collection', () => {
    const bad = f.model({ entity: f.byId([f.entity('e1', 'orders', 'n1')]) });
    const entities: Record<string, unknown> = bad.objects.entity;
    entities.e1 = { ...f.entity('e1', 'orders', 'n1'), position: { x: 0 } };
    expect(SchemaModelSchema.safeParse(bad).success).toBe(false);
  });

  it('carries `redacted` so clients can withhold edit affordances', () => {
    expect(SchemaModelSchema.parse({ ...f.model(), redacted: true }).redacted).toBe(true);
  });
});

describe('emptyCollections', () => {
  it('produces one empty record per type', () => {
    const empty: IrCollections = emptyCollections();
    expect(Object.keys(empty).sort()).toEqual([...IR_OBJECT_TYPES].sort());
    expect(Object.values(empty).every((c) => Object.keys(c).length === 0)).toBe(true);
  });

  it('returns a fresh object each call — no shared mutable default', () => {
    expect(emptyCollections()).not.toBe(emptyCollections());
  });
});
