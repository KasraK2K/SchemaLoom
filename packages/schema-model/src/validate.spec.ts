import { describe, expect, it } from 'vitest';

import { MAX_FIELD_DEPTH } from './constants.js';
import type { EngineProps } from './base.js';
import * as f from './fixtures.js';
import type { SchemaModel } from './model.js';
import { validateModel, type ValidationIssue } from './validate.js';

/** A structurally sound model — every check below breaks exactly one thing in it. */
function valid(): SchemaModel {
  return f.model({
    namespace: f.byId([f.namespace('ns', 'public', { isDefault: true })]),
    area: f.byId([f.area('a', 'Core')]),
    entity: f.byId([
      f.entity('e1', 'orders', 'ns', { areaId: 'a' }),
      f.entity('e2', 'customers', 'ns'),
    ]),
    field: f.byId([
      f.field('f1', 'id', 'e1', { ordinal: 0 }),
      f.field('f2', 'customer_id', 'e1', { ordinal: 1 }),
      f.field('f3', 'id', 'e2', { ordinal: 0 }),
    ]),
    link: f.byId([
      f.link('l1', 'fk_orders_customer', 'e1', 'e2', {
        from: { entityId: 'e1', fieldIds: ['f2'] },
        to: { entityId: 'e2', fieldIds: ['f3'] },
      }),
    ]),
    index: f.byId([
      f.index('i1', 'ix_orders_id', 'e1', {
        columns: [{ ordinal: 0, fieldId: 'f1', expression: null, role: 'key', engineProps: {} }],
      }),
    ]),
    constraint: f.byId([
      f.constraint('c1', 'orders_pkey', 'e1', { kind: 'primaryKey', fieldIds: ['f1'] }),
    ]),
    customType: f.byId([f.customType('ct1', 'order_status', 'ns')]),
  });
}

const of = (issues: ValidationIssue[], code: string): ValidationIssue[] =>
  issues.filter((i) => i.code === code);

describe('validateModel', () => {
  it('passes a sound model', () => {
    expect(validateModel(valid())).toEqual([]);
  });

  it('reports an id used by two collections, and a mis-keyed record', () => {
    const model = valid();
    model.objects.field.e1 = f.field('e1', 'clash', 'e1');
    model.objects.entity.wrong_key = f.entity('e3', 'other', 'ns');

    const issues = validateModel(model);
    expect(of(issues, 'ID_COLLISION').map((i) => i.objectId)).toEqual(['e1']);
    expect(of(issues, 'KEY_MISMATCH')[0]).toMatchObject({
      objectType: 'entity',
      objectId: 'wrong_key',
    });
  });

  it('reports every dangling reference with the path that holds it', () => {
    const model = valid();
    model.objects.entity.e1 = f.entity('e1', 'orders', 'ns_gone', { areaId: 'a_gone' });
    model.objects.field.f4 = f.field('f4', 'orphan', 'e_gone');
    model.objects.field.f5 = f.field('f5', 'typed', 'e1', {
      ordinal: 2,
      type: { name: 'status', customTypeId: 'ct_gone' },
    });
    model.objects.constraint.c1 = f.constraint('c1', 'orders_pkey', 'e1', {
      kind: 'primaryKey',
      fieldIds: ['f_gone'],
    });
    model.objects.index.i2 = f.index('i2', 'ix_gone', 'e1', {
      columns: [{ ordinal: 0, fieldId: 'f_gone', expression: null, role: 'key', engineProps: {} }],
    });
    model.objects.link.l2 = f.link('l2', 'fk_gone', 'e_gone', 'e2');

    const dangling = of(validateModel(model), 'DANGLING_REFERENCE');
    const located = dangling.map((i) => `${i.objectId}:${(i.path ?? []).join('.')}`);
    expect(located).toContain('e1:namespaceId');
    expect(located).toContain('e1:areaId');
    expect(located).toContain('f4:entityId');
    expect(located).toContain('f5:type.customTypeId');
    expect(located).toContain('c1:fieldIds.0');
    expect(located).toContain('i2:columns.0.fieldId');
    expect(located).toContain('l2:from.entityId');
    for (const issue of dangling) expect(issue.message).toContain('does not resolve');
  });

  it('reports a field whose parent leaves its entity', () => {
    const model = valid();
    model.objects.field.f3 = f.field('f3', 'id', 'e2', { parentFieldId: 'f1' });

    const issue = of(validateModel(model), 'FIELD_PARENT_ENTITY')[0];
    expect(issue).toMatchObject({ objectId: 'f3', severity: 'error' });
    expect(issue?.message).toContain('e1');
  });

  it('catches a nesting cycle instead of hanging', () => {
    const model = valid();
    model.objects.field.f1 = f.field('f1', 'id', 'e1', { parentFieldId: 'f2' });
    model.objects.field.f2 = f.field('f2', 'customer_id', 'e1', {
      ordinal: 1,
      parentFieldId: 'f1',
    });

    const cycles = of(validateModel(model), 'FIELD_PARENT_CYCLE');
    expect(cycles.map((i) => i.objectId).sort()).toEqual(['f1', 'f2']);
  });

  it('reports nesting deeper than MAX_FIELD_DEPTH', () => {
    const fields = [f.field('d0', 'd0', 'e1', { ordinal: 0 })];
    for (let i = 1; i <= MAX_FIELD_DEPTH; i++) {
      const name = `d${String(i)}`;
      fields.push(f.field(name, name, 'e1', { parentFieldId: `d${String(i - 1)}` }));
    }
    const model = valid();
    model.objects.field = f.byId(fields);

    const tooDeep = of(validateModel(model), 'FIELD_DEPTH_EXCEEDED');
    expect(tooDeep.map((i) => i.objectId)).toEqual([`d${String(MAX_FIELD_DEPTH)}`]);
    expect(tooDeep[0]?.message).toContain(String(MAX_FIELD_DEPTH));
  });

  it('reports duplicate and non-dense ordinals in a sibling group', () => {
    const duplicate = valid();
    duplicate.objects.field.f2 = f.field('f2', 'customer_id', 'e1', { ordinal: 0 });
    const collisions = of(validateModel(duplicate), 'ORDINAL_COLLISION');
    expect(collisions.map((i) => i.objectId).sort()).toEqual(['f1', 'f2']);
    expect(collisions[0]?.message).toContain('ordinal 0');

    const gapped = valid();
    gapped.objects.field.f2 = f.field('f2', 'customer_id', 'e1', { ordinal: 7 });
    expect(of(validateModel(gapped), 'ORDINAL_COLLISION')[0]?.message).toContain('not dense');

    const columns = valid();
    columns.objects.index.i1 = f.index('i1', 'ix_orders_id', 'e1', {
      columns: [
        { ordinal: 0, fieldId: 'f1', expression: null, role: 'key', engineProps: {} },
        { ordinal: 0, fieldId: 'f2', expression: null, role: 'key', engineProps: {} },
      ],
    });
    expect(of(validateModel(columns), 'ORDINAL_COLLISION')[0]).toMatchObject({
      objectType: 'index',
      objectId: 'i1',
    });
  });

  it('reports a name collision per scope, folding through normalizeName', () => {
    const model = valid();
    model.objects.entity.e2 = f.entity('e2', 'ORDERS', 'ns');

    expect(of(validateModel(model), 'NAME_COLLISION')).toEqual([]);
    const lowered = validateModel(model, { normalizeName: (n) => n.toLowerCase() });
    const folded = of(lowered, 'NAME_COLLISION');
    expect(folded.length).toBe(1);
    expect(folded[0]?.message).toContain('ORDERS');

    // A restricted object is skipped: its name was blanked by the filter, not by a user.
    const restricted = valid();
    restricted.objects.entity.e2 = f.entity('e2', 'orders', 'ns', { restricted: true });
    expect(of(validateModel(restricted), 'NAME_COLLISION')).toEqual([]);
  });

  it('warns, never errors, on a duplicate logical key', () => {
    const model = valid();
    // Two table-level CHECKs on one table: ordinary PostgreSQL, same shape of key.
    model.objects.constraint.c2 = f.constraint('c2', 'positive', 'e1', { kind: 'check' });
    model.objects.constraint.c3 = f.constraint('c3', 'positive', 'e1', { kind: 'check' });

    const duplicates = of(validateModel(model), 'DUPLICATE_LOGICAL_KEY');
    expect(duplicates.length).toBe(1);
    expect(duplicates[0]?.severity).toBe('warning');
  });

  it('reports link arity and an endpoint field that is not on the named entity', () => {
    const model = valid();
    model.objects.link.l1 = f.link('l1', 'fk', 'e1', 'e2', {
      from: { entityId: 'e1', fieldIds: ['f2'] },
      to: { entityId: 'e2', fieldIds: [] },
    });
    model.objects.link.l2 = f.link('l2', 'fk2', 'e1', 'e2', {
      from: { entityId: 'e1', fieldIds: ['f3'] },
      to: { entityId: 'e2', fieldIds: ['f3'] },
    });

    const issues = validateModel(model);
    expect(of(issues, 'LINK_ARITY').map((i) => i.objectId)).toEqual(['l1']);
    const owner = of(issues, 'LINK_FIELD_OWNER');
    expect(owner.map((i) => i.objectId)).toEqual(['l2']);
    expect(owner[0]?.path).toEqual(['from', 'fieldIds', '0']);
  });

  it('reports a malformed engineProps container and a malformed index column', () => {
    const model = valid();
    model.objects.entity.e2 = {
      ...f.entity('e2', 'customers', 'ns'),
      engineProps: [] as unknown as EngineProps,
    };
    model.objects.index.i2 = f.index('i2', 'ix_both', 'e1', {
      columns: [
        { ordinal: 0, fieldId: 'f1', expression: 'lower(id)', role: 'key', engineProps: {} },
      ],
    });
    model.objects.index.i3 = f.index('i3', 'ix_neither', 'e1', {
      columns: [{ ordinal: 0, fieldId: null, expression: null, role: 'key', engineProps: {} }],
    });

    const issues = validateModel(model);
    expect(of(issues, 'ENGINE_PROPS_SHAPE').map((i) => i.objectId)).toEqual(['e2']);
    const sources = of(issues, 'INDEX_COLUMN_SOURCE').map((i) => i.objectId);
    expect(sources.sort()).toEqual(['i2', 'i3']);
  });

  it('warns on an empty name, but not on a restricted object', () => {
    const model = valid();
    model.objects.entity.e2 = f.entity('e2', '', 'ns');
    model.objects.entity.e3 = f.entity('e3', '', 'ns', { restricted: true });
    model.objects.link.l3 = f.link('l3', '', 'e1', 'e2');

    const empty = of(validateModel(model), 'EMPTY_NAME');
    expect(empty.map((i) => i.objectId)).toEqual(['e2']);
    expect(empty[0]?.severity).toBe('warning');
  });

  it('scopes the report to the named objects and their parent scopes', () => {
    const model = valid();
    model.objects.field.f4 = f.field('f4', 'orphan', 'e_gone');
    model.objects.entity.e2 = f.entity('e2', 'customers', 'ns_gone');

    expect(of(validateModel(model), 'DANGLING_REFERENCE').length).toBe(2);
    const scoped = validateModel(model, { scope: [{ type: 'field', id: 'f4' }] });
    expect(of(scoped, 'DANGLING_REFERENCE').map((i) => i.objectId)).toEqual(['f4']);
  });
});
