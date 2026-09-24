import { describe, expect, it } from 'vitest';

import { assembleModel } from './assemble.js';
import type { ObjectRefs } from './base.js';
import { DOC_EXCERPT_CHARS } from './doc-ref.js';
import { SchemaModelSchema } from './model.js';
import type { AssemblyInput, AssemblyRows } from './rows.js';

const NO_REFS: ObjectRefs = { entityIds: [], fieldIds: [] };

const emptyRows: AssemblyRows = {
  area: [],
  namespace: [],
  customType: [],
  entity: [],
  field: [],
  constraint: [],
  constraintColumn: [],
  index: [],
  indexColumn: [],
  link: [],
  linkEndpoint: [],
  doc: [],
};

function assemble(rows: Partial<AssemblyRows>): ReturnType<typeof assembleModel> {
  const input: AssemblyInput = {
    projectId: 'prj_1',
    engineId: 'postgresql',
    engineVersion: '16',
    rows: { ...emptyRows, ...rows },
  };
  return assembleModel(input);
}

const publicNs = {
  id: 'ns_public',
  name: 'public',
  isDefault: true,
  engineProps: {},
  refs: NO_REFS,
  version: 1,
};

const ordersRow = {
  id: 'e_orders',
  namespaceId: null,
  areaId: null,
  name: 'orders',
  kind: 'table',
  positionX: 10,
  positionY: 20,
  width: null,
  height: null,
  color: null,
  engineProps: { unlogged: true },
  refs: NO_REFS,
  version: 3,
};

function fieldRow(id: string, name: string, position: number): AssemblyRows['field'][number] {
  return {
    id,
    entityId: 'e_orders',
    parentFieldId: null,
    name,
    dataType: 'text',
    customTypeId: null,
    typeArgs: [],
    typeDimensions: 0,
    position,
    isNullable: false,
    isRestricted: false,
    isPii: false,
    isDeprecated: false,
    engineProps: {},
    refs: NO_REFS,
    version: 1,
  };
}

describe('assembleModel', () => {
  it('produces the expected maps, keyed by id', () => {
    const model = assemble({
      namespace: [publicNs],
      entity: [ordersRow],
      field: [fieldRow('f_id', 'id', 0), fieldRow('f_total', 'total', 1)],
    });

    expect(Object.keys(model.objects.entity)).toEqual(['e_orders']);
    expect(Object.keys(model.objects.field).sort()).toEqual(['f_id', 'f_total']);
    expect(model.objects.entity.e_orders).toMatchObject({
      id: 'e_orders',
      name: 'orders',
      namespaceId: 'ns_public',
      position: { x: 10, y: 20 },
      version: 3,
      engineProps: { unlogged: true },
    });
    expect(model.irVersion).toBe(1);
    expect(model.redacted).toBe(false);
    expect(model.engineId).toBe('postgresql');
    expect(SchemaModelSchema.safeParse(model).success).toBe(true);
  });

  it('resolves a null namespaceId to the default namespace', () => {
    const model = assemble({
      namespace: [{ ...publicNs, id: 'ns_other', name: 'other', isDefault: false }, publicNs],
      entity: [ordersRow],
      customType: [
        {
          id: 'ct_1',
          namespaceId: null,
          name: 'order_status',
          kind: 'enum',
          engineProps: {},
          refs: NO_REFS,
          version: 1,
        },
      ],
    });
    expect(model.objects.entity.e_orders?.namespaceId).toBe('ns_public');
    expect(model.objects.customType.ct_1?.namespaceId).toBe('ns_public');
  });

  it('orders child rows by ordinal, not by insertion order', () => {
    const model = assemble({
      namespace: [publicNs],
      entity: [ordersRow, { ...ordersRow, id: 'e_customers', name: 'customers' }],
      field: [fieldRow('f_b', 'b', 1), fieldRow('f_a', 'a', 0)],
      constraint: [
        {
          id: 'c_pk',
          entityId: 'e_orders',
          name: null,
          kind: 'primaryKey',
          expression: null,
          engineProps: {},
          refs: NO_REFS,
          version: 1,
        },
      ],
      // deliberately reversed
      constraintColumn: [
        { constraintId: 'c_pk', ordinal: 1, fieldId: 'f_b' },
        { constraintId: 'c_pk', ordinal: 0, fieldId: 'f_a' },
      ],
      index: [
        {
          id: 'ix_1',
          entityId: 'e_orders',
          name: 'ix_orders',
          method: 'btree',
          isUnique: true,
          engineProps: {},
          refs: NO_REFS,
          version: 1,
        },
      ],
      indexColumn: [
        {
          indexId: 'ix_1',
          ordinal: 1,
          fieldId: null,
          expression: 'lower(b)',
          direction: 'desc',
          isInclude: true,
          engineProps: {},
        },
        {
          indexId: 'ix_1',
          ordinal: 0,
          fieldId: 'f_a',
          expression: null,
          direction: 'weird',
          isInclude: false,
          engineProps: { opclass: 'text_ops' },
        },
      ],
      link: [
        {
          id: 'l_1',
          name: null,
          kind: 'foreignKey',
          cardinality: 'many_to_many',
          sourceEntityId: 'e_orders',
          targetEntityId: 'e_customers',
          engineProps: {},
          refs: NO_REFS,
          version: 1,
        },
      ],
      linkEndpoint: [
        { linkId: 'l_1', ordinal: 1, sourceFieldId: 'f_b', targetFieldId: 'f_b2' },
        { linkId: 'l_1', ordinal: 0, sourceFieldId: 'f_a', targetFieldId: 'f_a2' },
      ],
    });

    expect(model.objects.constraint.c_pk?.fieldIds).toEqual(['f_a', 'f_b']);
    expect(model.objects.constraint.c_pk?.name).toBe('');

    const columns = model.objects.index.ix_1!.columns;
    expect(columns.map((c) => c.ordinal)).toEqual([0, 1]);
    expect(columns[0]).toMatchObject({ fieldId: 'f_a', role: 'key', direction: undefined });
    expect(columns[1]).toMatchObject({
      expression: 'lower(b)',
      role: 'include',
      direction: 'desc',
    });

    const link = model.objects.link.l_1!;
    expect(link.from.fieldIds).toEqual(['f_a', 'f_b']);
    expect(link.to.fieldIds).toEqual(['f_a2', 'f_b2']);
    expect(link.cardinality).toBe('N:M');
    expect(link.name).toBe('');
  });

  it('maps the type columns onto TypeRef and drops empty optionals', () => {
    const model = assemble({
      namespace: [publicNs],
      entity: [ordersRow],
      field: [
        { ...fieldRow('f_plain', 'plain', 0) },
        {
          ...fieldRow('f_typed', 'typed', 1),
          dataType: 'varchar',
          typeArgs: [255],
          typeDimensions: 2,
          customTypeId: 'ct_1',
        },
      ],
    });

    expect(model.objects.field.f_plain?.type).toEqual({
      name: 'text',
      args: undefined,
      customTypeId: null,
      dimensions: undefined,
    });
    expect(model.objects.field.f_typed?.type).toEqual({
      name: 'varchar',
      args: [255],
      customTypeId: 'ct_1',
      dimensions: 2,
    });
  });

  it('copies a constraint expression into engineProps and omits empty refs', () => {
    const model = assemble({
      namespace: [publicNs],
      entity: [ordersRow],
      constraint: [
        {
          id: 'c_check',
          entityId: 'e_orders',
          name: 'total_positive',
          kind: 'check',
          expression: 'total > 0',
          engineProps: { deferrable: false },
          refs: { entityIds: [], fieldIds: ['f_total'] },
          version: 1,
        },
      ],
    });

    expect(model.objects.constraint.c_check?.engineProps).toEqual({
      deferrable: false,
      expression: 'total > 0',
    });
    expect(model.objects.constraint.c_check?.refs).toEqual({
      entityIds: [],
      fieldIds: ['f_total'],
    });
    expect(model.objects.entity.e_orders?.refs).toBeUndefined();
  });

  it('attaches docs by target and truncates the excerpt on a word boundary', () => {
    const long = 'word '.repeat(80).trim();
    const model = assemble({
      namespace: [publicNs],
      area: [{ id: 'a_1', name: 'Billing', color: 'indigo', position: 2, version: 1 }],
      entity: [ordersRow],
      field: [fieldRow('f_id', 'id', 0)],
      doc: [
        { id: 'd_area', targetType: 'area', targetId: 'a_1', plainText: 'area doc' },
        { id: 'd_entity', targetType: 'entity', targetId: 'e_orders', plainText: long },
        { id: 'd_none', targetType: 'field', targetId: 'f_missing', plainText: 'orphan' },
      ],
    });

    expect(model.objects.area.a_1?.ordinal).toBe(2);
    expect(model.objects.area.a_1?.engineProps).toEqual({});
    expect(model.objects.area.a_1?.doc).toEqual({ id: 'd_area', excerpt: 'area doc' });

    const excerpt = model.objects.entity.e_orders!.doc!.excerpt;
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(DOC_EXCERPT_CHARS + 1);
    expect(excerpt.slice(0, -1).endsWith('word')).toBe(true);

    expect(model.objects.field.f_id?.doc).toBeNull();
  });

  it('never throws on a dangling reference — validateModel is what reports it', () => {
    const model = assemble({
      namespace: [],
      field: [{ ...fieldRow('f_orphan', 'orphan', 0), entityId: 'e_gone' }],
    });
    expect(model.objects.field.f_orphan?.entityId).toBe('e_gone');
    // No namespace row at all: the default namespace id is empty rather than invented.
    expect(Object.keys(model.objects.namespace)).toEqual([]);
  });
});
