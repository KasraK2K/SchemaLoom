import { emptyCollections, type SchemaModel } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import type { SchemaOperation } from './ops';
import { requirementsOf, type LiveModel } from './requirements';

/**
 * Doc 04 §8.5 — the op → atoms table, one case per row. This is the file that decides
 * whether a Documenter can rewrite a schema and whether a `schema:edit` holder can
 * un-restrict a salary column, so every row is asserted rather than sampled.
 */

const ORDERS = 'ent_orders';
const USERS = 'ent_users';
const SALES = 'area_sales';
const EU = 'area_eu';

const base = { version: 3, engineProps: {} } as const;

function live(): LiveModel {
  const objects = emptyCollections();
  objects.area[SALES] = { ...base, id: SALES, name: 'Sales', color: 'indigo', ordinal: 0, doc: null };
  objects.namespace.ns = { ...base, id: 'ns', name: 'public', isDefault: true };
  objects.entity[ORDERS] = {
    ...base,
    id: ORDERS,
    name: 'orders',
    namespaceId: 'ns',
    kind: 'table',
    areaId: SALES,
    position: { x: 0, y: 0 },
    color: null,
    doc: null,
  };
  objects.entity[USERS] = { ...objects.entity[ORDERS], id: USERS, name: 'users', areaId: null };
  objects.field.fld_salary = {
    ...base,
    id: 'fld_salary',
    name: 'salary',
    entityId: ORDERS,
    parentFieldId: null,
    ordinal: 0,
    type: { name: 'numeric' },
    isNullable: true,
    isRestricted: false,
    isPii: false,
    isDeprecated: false,
    doc: null,
  };
  objects.index.idx_a = {
    ...base,
    id: 'idx_a',
    name: 'idx_a',
    entityId: ORDERS,
    kind: 'btree',
    isUnique: false,
    columns: [],
  };
  objects.constraint.con_a = {
    ...base,
    id: 'con_a',
    name: 'con_a',
    entityId: ORDERS,
    kind: 'primaryKey',
    fieldIds: [],
  };
  objects.link.lnk_a = {
    ...base,
    id: 'lnk_a',
    name: 'fk',
    kind: 'foreign_key',
    cardinality: 'N:1',
    from: { entityId: ORDERS, fieldIds: [] },
    to: { entityId: USERS, fieldIds: [] },
  };
  const model: SchemaModel = {
    irVersion: 1,
    projectId: 'prj_shop',
    engineId: 'postgresql',
    engineVersion: '16',
    redacted: true,
    objects,
  };
  return { model };
}

/** `schema:edit@entity:ent_orders` — the shape assertions read in. */
const at = (op: SchemaOperation): string[] =>
  requirementsOf(op, live())
    .map((r) => `${r.atom}@${r.ref.type}:${r.ref.id}`)
    .sort();

const entityObject = (over: Record<string, unknown> = {}) => ({
  id: 'ent_new',
  name: 'new',
  engineProps: {},
  namespaceId: 'ns',
  kind: 'table',
  areaId: null,
  position: { x: 0, y: 0 },
  width: undefined,
  height: undefined,
  color: null,
  ...over,
});

const fieldObject = (over: Record<string, unknown> = {}) => ({
  id: 'fld_new',
  name: 'new',
  engineProps: {},
  entityId: ORDERS,
  parentFieldId: null,
  type: { name: 'text' },
  isNullable: true,
  isRestricted: false,
  isPii: false,
  isDeprecated: false,
  ...over,
});

describe('requirementsOf — creates', () => {
  it('an entity needs project edit, plus the Area it lands in', () => {
    expect(at({ op: 'create', type: 'entity', object: entityObject() })).toEqual([
      'schema:edit@project:prj_shop',
    ]);
    expect(
      at({ op: 'create', type: 'entity', object: entityObject({ areaId: EU }) }),
    ).toEqual(['schema:edit@area:area_eu', 'schema:edit@project:prj_shop']);
  });

  it('a field needs edit on its entity, and field:viewRestricted when it is born restricted', () => {
    expect(at({ op: 'create', type: 'field', object: fieldObject() })).toEqual([
      'schema:edit@entity:ent_orders',
    ]);
    // doc 05 R20 — you must be able to SEE a field to classify it.
    expect(
      at({
        op: 'create',
        type: 'field',
        object: fieldObject({ isRestricted: true }),
      }),
    ).toEqual(['field:viewRestricted@entity:ent_orders', 'schema:edit@entity:ent_orders']);
  });

  it('a link needs edit on BOTH endpoints (R19), de-duplicated on a self-link', () => {
    const link = {
      id: 'lnk_new',
      name: 'fk',
      engineProps: {},
      kind: 'foreign_key',
      cardinality: 'N:1',
      from: { entityId: ORDERS, fieldIds: [] },
      to: { entityId: USERS, fieldIds: [] },
    };
    expect(at({ op: 'create', type: 'link', object: link } as SchemaOperation)).toEqual([
      'schema:edit@entity:ent_orders',
      'schema:edit@entity:ent_users',
    ]);
    expect(
      at({
        op: 'create',
        type: 'link',
        object: { ...link, to: { entityId: ORDERS, fieldIds: [] } },
      } as SchemaOperation),
    ).toEqual(['schema:edit@entity:ent_orders']);
  });

  it('namespaces, custom types and areas are project-level', () => {
    for (const type of ['namespace', 'customType', 'area'] as const) {
      const object =
        type === 'namespace'
          ? { id: 'x', name: 'x', engineProps: {}, isDefault: false }
          : type === 'customType'
            ? { id: 'x', name: 'x', engineProps: {}, namespaceId: 'ns', kind: 'enum' }
            : { id: 'x', name: 'x', engineProps: {}, color: 'indigo', ordinal: 0 };
      expect(at({ op: 'create', type, object } as SchemaOperation)).toEqual([
        'schema:edit@project:prj_shop',
      ]);
    }
  });
});

describe('requirementsOf — updates', () => {
  const update = (type: string, id: string, patch: Record<string, unknown>): SchemaOperation =>
    ({ op: 'update', type, id, expectedVersion: 3, patch }) as SchemaOperation;

  it('renaming an entity needs edit on that entity only', () => {
    expect(at(update('entity', ORDERS, { name: 'o' }))).toEqual(['schema:edit@entity:ent_orders']);
  });

  it('moving an entity between Areas needs edit on the OLD and the NEW one', () => {
    expect(at(update('entity', ORDERS, { areaId: EU }))).toEqual([
      'schema:edit@area:area_eu',
      'schema:edit@area:area_sales',
      'schema:edit@entity:ent_orders',
    ]);
    // Out of an Area and into none: the Area being left still has to permit it.
    expect(at(update('entity', ORDERS, { areaId: null }))).toEqual([
      'schema:edit@area:area_sales',
      'schema:edit@entity:ent_orders',
    ]);
  });

  it('restricting a field needs field:viewRestricted; UN-restricting needs sharing:manage', () => {
    expect(at(update('field', 'fld_salary', { isRestricted: true }))).toEqual([
      'field:viewRestricted@entity:ent_orders',
      'schema:edit@entity:ent_orders',
    ]);
    // R20 — de-restriction is an access-control change, not an edit. `schema:edit` is
    // deliberately NOT in this list: an editor who could clear the flag could read the
    // value on the next fetch.
    expect(at(update('field', 'fld_salary', { isRestricted: false }))).toEqual([
      'sharing:manage@entity:ent_orders',
    ]);
    expect(at(update('field', 'fld_salary', { name: 'pay' }))).toEqual([
      'schema:edit@entity:ent_orders',
    ]);
  });

  it('an index or constraint moved to another entity needs edit on both', () => {
    expect(at(update('index', 'idx_a', { name: 'x' }))).toEqual(['schema:edit@entity:ent_orders']);
    expect(at(update('index', 'idx_a', { entityId: USERS }))).toEqual([
      'schema:edit@entity:ent_orders',
      'schema:edit@entity:ent_users',
    ]);
    expect(at(update('constraint', 'con_a', { entityId: USERS }))).toEqual([
      'schema:edit@entity:ent_orders',
      'schema:edit@entity:ent_users',
    ]);
  });

  it('re-pointing a link endpoint needs edit on the old and the new entity of that side', () => {
    expect(
      at(update('link', 'lnk_a', { to: { entityId: 'ent_third', fieldIds: [] } })),
    ).toEqual([
      'schema:edit@entity:ent_orders',
      'schema:edit@entity:ent_third',
      'schema:edit@entity:ent_users',
    ]);
  });

  it('an area update is scoped to that area, not to the project', () => {
    expect(at(update('area', SALES, { name: 'S' }))).toEqual(['schema:edit@area:area_sales']);
  });
});

describe('requirementsOf — deletes and moves', () => {
  const del = (type: string, id: string): SchemaOperation =>
    ({ op: 'delete', type, id, expectedVersion: 3 }) as SchemaOperation;

  it('resolves a child object to its owning entity', () => {
    expect(at(del('field', 'fld_salary'))).toEqual(['schema:edit@entity:ent_orders']);
    expect(at(del('index', 'idx_a'))).toEqual(['schema:edit@entity:ent_orders']);
    expect(at(del('constraint', 'con_a'))).toEqual(['schema:edit@entity:ent_orders']);
    expect(at(del('link', 'lnk_a'))).toEqual([
      'schema:edit@entity:ent_orders',
      'schema:edit@entity:ent_users',
    ]);
  });

  it('a move is one requirement on the owning entity', () => {
    expect(
      at({
        op: 'move',
        type: 'field',
        id: 'fld_salary',
        beforeFieldId: null,
        expectedVersion: 3,
      }),
    ).toEqual(['schema:edit@entity:ent_orders']);
  });

  it('fails CLOSED to project-level edit when the object is not in the live model', () => {
    // Narrower than any area- or entity-scoped grant, so an op that somehow slipped past
    // the visibility gate is refused rather than waved through on an empty list.
    expect(at(del('field', 'fld_ghost'))).toEqual(['schema:edit@project:prj_shop']);
  });

  it('never derives docs:edit — `doc` is server-owned, so a Documenter is refused', () => {
    const ops: SchemaOperation[] = [
      del('entity', ORDERS),
      { op: 'update', type: 'entity', id: ORDERS, expectedVersion: 3, patch: { name: 'x' } },
    ];
    for (const op of ops) {
      expect(requirementsOf(op, live()).map((r) => r.atom)).not.toContain('docs:edit');
    }
  });
});
