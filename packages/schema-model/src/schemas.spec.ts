import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { AreaSchema } from './area.js';
import { IrBaseSchema, ObjectRefsSchema } from './base.js';
import { ConstraintSchema } from './constraint.js';
import { CustomTypeSchema } from './custom-type.js';
import { DocRefSchema } from './doc-ref.js';
import { EntitySchema } from './entity.js';
import { FieldSchema } from './field.js';
import * as f from './fixtures.js';
import { IndexColumnSchema, IndexSchema } from './ir-index.js';
import { LinkSchema } from './link.js';
import { IR_OBJECT_SCHEMAS, type IrObjectType } from './model.js';
import { NamespaceSchema } from './namespace.js';
import { TypeRefSchema } from './type-ref.js';

/** One minimal valid object per type, so the generic cases below run eight times. */
const MINIMAL: [type: IrObjectType, schema: z.ZodType, obj: Record<string, unknown>][] = [
  ['area', AreaSchema, f.area('a1', 'Billing')],
  ['namespace', NamespaceSchema, f.namespace('n1', 'public')],
  ['customType', CustomTypeSchema, f.customType('t1', 'order_status', 'n1')],
  ['entity', EntitySchema, f.entity('e1', 'orders', 'n1')],
  ['field', FieldSchema, f.field('fl1', 'id', 'e1')],
  ['constraint', ConstraintSchema, f.constraint('c1', 'chk', 'e1')],
  ['index', IndexSchema, f.index('i1', 'idx_orders', 'e1')],
  ['link', LinkSchema, f.link('l1', 'fk', 'e1', 'e1')],
];

describe('every object schema', () => {
  it.each(MINIMAL)('%s accepts a minimal valid object', (_type, schema, obj) => {
    expect(schema.parse(obj)).toEqual(obj);
  });

  it.each(MINIMAL)('%s rejects a missing engineProps bag', (_type, schema, obj) => {
    const { engineProps: _drop, ...rest } = obj;
    expect(schema.safeParse(rest).success).toBe(false);
  });

  it.each(MINIMAL)('%s rejects engineProps as an array (C4)', (_type, schema, obj) => {
    expect(schema.safeParse({ ...obj, engineProps: [] }).success).toBe(false);
  });

  it.each(MINIMAL)('%s rejects an empty id', (_type, schema, obj) => {
    expect(schema.safeParse({ ...obj, id: '' }).success).toBe(false);
  });

  it.each(MINIMAL)('%s rejects a non-integer version', (_type, schema, obj) => {
    expect(schema.safeParse({ ...obj, version: 1.5 }).success).toBe(false);
  });

  it('IR_OBJECT_SCHEMAS points at the same schemas, one per type', () => {
    expect(MINIMAL).toHaveLength(Object.keys(IR_OBJECT_SCHEMAS).length);
    for (const [type, schema] of MINIMAL) {
      expect(IR_OBJECT_SCHEMAS[type]).toBe(schema);
    }
  });
});

describe('IrBase', () => {
  it('round-trips through parse', () => {
    const base = {
      ...f.irBase('o1', 'orders'),
      engineProps: { unlogged: true, tablespace: null, inherits: ['a', 'b'] },
      refs: { entityIds: ['e1'], fieldIds: ['fl1', 'fl2'] },
      restricted: true as const,
      propsRedacted: true as const,
    };
    const parsed = IrBaseSchema.parse(base);
    expect(parsed).toEqual(base);
    // Idempotent: the output of parse is itself valid input, which is what makes a
    // snapshot blob and a websocket frame the same bytes.
    expect(IrBaseSchema.parse(parsed)).toEqual(base);
  });

  it('accepts an empty name — links and constraints are often unnamed', () => {
    expect(IrBaseSchema.safeParse(f.irBase('o1', '')).success).toBe(true);
  });

  it('rejects a negative version', () => {
    expect(IrBaseSchema.safeParse({ ...f.irBase('o1'), version: -1 }).success).toBe(false);
  });

  it('rejects null engineProps', () => {
    expect(IrBaseSchema.safeParse({ ...f.irBase('o1'), engineProps: null }).success).toBe(false);
  });

  it('caps refs so a runaway extractReferences cannot ship megabytes', () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => `e${String(i)}`);
    expect(ObjectRefsSchema.safeParse({ entityIds: tooMany, fieldIds: [] }).success).toBe(false);
  });
});

describe('the two redaction flags (RECONCILIATION R-1)', () => {
  const base = f.irBase('o1', 'orders');

  it('are both absent on a fully visible object', () => {
    const parsed = IrBaseSchema.parse(base);
    expect(parsed.restricted).toBeUndefined();
    expect(parsed.propsRedacted).toBeUndefined();
  });

  it('is settable alone — a hidden object', () => {
    const parsed = IrBaseSchema.parse({ ...base, restricted: true });
    expect(parsed.restricted).toBe(true);
    expect(parsed.propsRedacted).toBeUndefined();
  });

  it('propsRedacted is settable alone — a VISIBLE object with blanked engineProps', () => {
    const parsed = IrBaseSchema.parse({ ...base, propsRedacted: true });
    expect(parsed.propsRedacted).toBe(true);
    expect(parsed.restricted).toBeUndefined();
    // The whole point of R-1: `if (obj.restricted)` must not hide this object.
    expect(parsed.restricted ?? false).toBe(false);
  });

  it('are settable together', () => {
    const parsed = IrBaseSchema.parse({ ...base, restricted: true, propsRedacted: true });
    expect([parsed.restricted, parsed.propsRedacted]).toEqual([true, true]);
  });

  it('reject `false` — a flag is true or absent, never a tri-state', () => {
    expect(IrBaseSchema.safeParse({ ...base, restricted: false }).success).toBe(false);
    expect(IrBaseSchema.safeParse({ ...base, propsRedacted: false }).success).toBe(false);
  });

  it('reject the deleted RestrictionMark object form', () => {
    expect(IrBaseSchema.safeParse({ ...base, restricted: { level: 'stub' } }).success).toBe(false);
  });
});

describe('TypeRef', () => {
  it('accepts args, customTypeId and dimensions', () => {
    const t = { name: 'numeric', args: [10, 2], customTypeId: null, dimensions: 1 };
    expect(TypeRefSchema.parse(t)).toEqual(t);
  });

  it('accepts a blanked name — a masked field in a redacted model', () => {
    expect(TypeRefSchema.parse({ name: '' }).name).toBe('');
  });

  it('has no rendered `display` property', () => {
    const parsed: Record<string, unknown> = TypeRefSchema.parse({
      name: 'varchar',
      args: [255],
      display: 'character varying(255)',
    });
    expect(parsed.display).toBeUndefined();
  });

  it('rejects a boolean type arg', () => {
    expect(TypeRefSchema.safeParse({ name: 'numeric', args: [true] }).success).toBe(false);
  });

  it('rejects an absurd dimension count', () => {
    expect(TypeRefSchema.safeParse({ name: 'text', dimensions: 9 }).success).toBe(false);
  });
});

describe('DocRef', () => {
  it('accepts an empty excerpt — the object IS documented', () => {
    expect(DocRefSchema.parse({ id: 'd1', excerpt: '' }).excerpt).toBe('');
  });

  it('rejects an unbounded excerpt', () => {
    expect(DocRefSchema.safeParse({ id: 'd1', excerpt: 'x'.repeat(241) }).success).toBe(false);
  });
});

describe('Field', () => {
  it('validates a field nested via parentFieldId', () => {
    const child = f.field('fl2', 'lat', 'e1', { parentFieldId: 'fl1', ordinal: 0 });
    expect(FieldSchema.parse(child).parentFieldId).toBe('fl1');
  });

  it('rejects an empty parentFieldId string — null is how "top level" is spelled', () => {
    expect(FieldSchema.safeParse(f.field('fl1', 'id', 'e1', { parentFieldId: '' })).success).toBe(
      false,
    );
  });

  it('rejects a missing parentFieldId — the IR is always explicit', () => {
    const { parentFieldId: _drop, ...rest } = f.field('fl1', 'id', 'e1');
    expect(FieldSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a negative ordinal (C11)', () => {
    expect(FieldSchema.safeParse(f.field('fl1', 'id', 'e1', { ordinal: -1 })).success).toBe(false);
  });
});

describe('Link', () => {
  it('validates composite endpoints paired by index', () => {
    const composite = f.link('l1', 'fk_orders_customer', 'e1', 'e2', {
      from: { entityId: 'e1', fieldIds: ['f_cust', 'f_tenant'] },
      to: { entityId: 'e2', fieldIds: ['f_id', 'f_tenant2'] },
      cardinality: 'N:1',
    });
    const parsed = LinkSchema.parse(composite);
    expect(parsed.from.fieldIds).toHaveLength(parsed.to.fieldIds.length);
    expect(parsed.from.fieldIds[1]).toBe('f_tenant');
  });

  it('validates a self-reference', () => {
    const self = f.link('l1', 'fk_parent', 'e1', 'e1', {
      from: { entityId: 'e1', fieldIds: ['f_parent'] },
      to: { entityId: 'e1', fieldIds: ['f_id'] },
    });
    expect(LinkSchema.parse(self).from.entityId).toBe(LinkSchema.parse(self).to.entityId);
  });

  it('validates an entity-level link with no fields on either side', () => {
    expect(LinkSchema.safeParse(f.link('l1', 'draft', 'e1', 'e2')).success).toBe(true);
  });

  it('rejects an unknown cardinality', () => {
    const bad = { ...f.link('l1', 'fk', 'e1', 'e2'), cardinality: '1:many' };
    expect(LinkSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an endpoint with no entityId', () => {
    const bad = { ...f.link('l1', 'fk', 'e1', 'e2'), to: { fieldIds: [] } };
    expect(LinkSchema.safeParse(bad).success).toBe(false);
  });

  it('has no LinkEndpoint.role', () => {
    const parsed: Record<string, unknown> = LinkSchema.parse({
      ...f.link('l1', 'fk', 'e1', 'e2'),
      from: { entityId: 'e1', fieldIds: [], role: 'child' },
    }).from;
    expect(parsed.role).toBeUndefined();
  });
});

describe('IndexColumn', () => {
  const col = { ordinal: 0, fieldId: 'fl1', expression: null, role: 'key', engineProps: {} };

  it('accepts a field-backed column', () => {
    expect(IndexColumnSchema.safeParse(col).success).toBe(true);
  });

  it('accepts an expression-backed column', () => {
    const expr = { ...col, fieldId: null, expression: 'lower(email)' };
    expect(IndexColumnSchema.safeParse(expr).success).toBe(true);
  });

  it('rejects both sources set (INDEX_COLUMN_SOURCE)', () => {
    expect(IndexColumnSchema.safeParse({ ...col, expression: 'lower(email)' }).success).toBe(false);
  });

  it('rejects neither source set', () => {
    expect(IndexColumnSchema.safeParse({ ...col, fieldId: null }).success).toBe(false);
  });

  it('carries its own engineProps bag and an include role', () => {
    const include = { ...col, role: 'include', engineProps: { opclass: 'text_pattern_ops' } };
    const parsed = IndexColumnSchema.parse(include);
    expect(parsed.role).toBe('include');
    expect(parsed.engineProps.opclass).toBe('text_pattern_ops');
  });

  it('propagates a column failure to its Index', () => {
    const bad = f.index('i1', 'idx', 'e1', {
      columns: [{ ordinal: 0, fieldId: null, expression: null, role: 'key', engineProps: {} }],
    });
    expect(IndexSchema.safeParse(bad).success).toBe(false);
  });
});

describe('Area', () => {
  it('carries an engineProps bag, permanently {}', () => {
    expect(AreaSchema.parse(f.area('a1', 'Billing')).engineProps).toEqual({});
  });

  it('rejects an empty color token', () => {
    expect(AreaSchema.safeParse(f.area('a1', 'Billing', { color: '' })).success).toBe(false);
  });

  it('has no rect — the canvas derives the region from member entities', () => {
    const parsed: Record<string, unknown> = AreaSchema.parse({
      ...f.area('a1', 'Billing'),
      width: 100,
      height: 50,
    });
    expect(parsed.width).toBeUndefined();
  });
});
