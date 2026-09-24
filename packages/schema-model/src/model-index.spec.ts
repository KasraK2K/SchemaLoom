import { describe, expect, it } from 'vitest';

import type { Field } from './field.js';
import * as f from './fixtures.js';
import {
  joinPaths,
  linksOf,
  linksTouchingField,
  neighbours,
  topologicalEntityOrder,
} from './graph.js';
import type { Id } from './ids.js';
import { createIndex, indexOf } from './model-index.js';
import type { SchemaModel } from './model.js';
import {
  constraintsOf,
  entitiesOf,
  entitiesOfArea,
  fieldDepth,
  fieldNamePath,
  fieldPath,
  fieldsOf,
  findEntityByName,
  get,
  getEntity,
  indexesOf,
  isForeignKeyField,
  isPrimaryKey,
  isUniqueField,
  primaryKeyFields,
  resolveNamePath,
} from './traverse.js';

/**
 * One fixture for the whole file: four linked entities, one isolated one, a nested
 * field tree on `customers`, and every object inserted in an order that disagrees with
 * the order the helpers must return.
 */
function fixture(): SchemaModel {
  const entities = [
    f.entity('e_orders', 'orders', 'ns_public'),
    f.entity('e_customers', 'customers', 'ns_public', { areaId: 'a_core' }),
    f.entity('e_products', 'products', 'ns_public'),
    f.entity('e_items', 'items', 'ns_public', { areaId: 'a_core' }),
    f.entity('e_isolated', 'isolated', 'ns_rep'),
  ];

  // Reverse ordinal order on purpose: insertion order must not leak into any result.
  const fields = [
    f.field('f_geo_lat', 'lat', 'e_customers', { parentFieldId: 'f_addr_geo', ordinal: 0 }),
    f.field('f_addr_geo', 'geo', 'e_customers', { parentFieldId: 'f_cust_addr', ordinal: 1 }),
    f.field('f_addr_city', 'city', 'e_customers', { parentFieldId: 'f_cust_addr', ordinal: 0 }),
    f.field('f_cust_addr', 'address', 'e_customers', { ordinal: 2 }),
    f.field('f_cust_email', 'email', 'e_customers', { ordinal: 1 }),
    f.field('f_cust_id', 'id', 'e_customers', { ordinal: 0 }),
    f.field('f_ord_customer', 'customer_id', 'e_orders', { ordinal: 1 }),
    f.field('f_ord_id', 'id', 'e_orders', { ordinal: 0 }),
    f.field('f_item_product', 'product_id', 'e_items', { ordinal: 2 }),
    f.field('f_item_order', 'order_id', 'e_items', { ordinal: 1 }),
    f.field('f_item_id', 'id', 'e_items', { ordinal: 0 }),
    f.field('f_prod_id', 'id', 'e_products', { ordinal: 0 }),
  ];

  const links = [
    f.link('l_ord_cust', 'fk_orders_customer', 'e_orders', 'e_customers', {
      from: { entityId: 'e_orders', fieldIds: ['f_ord_customer'] },
      to: { entityId: 'e_customers', fieldIds: ['f_cust_id'] },
    }),
    f.link('l_item_ord', 'fk_items_order', 'e_items', 'e_orders', {
      from: { entityId: 'e_items', fieldIds: ['f_item_order'] },
      to: { entityId: 'e_orders', fieldIds: ['f_ord_id'] },
    }),
    f.link('l_item_prod', 'fk_items_product', 'e_items', 'e_products', {
      from: { entityId: 'e_items', fieldIds: ['f_item_product'] },
      to: { entityId: 'e_products', fieldIds: ['f_prod_id'] },
    }),
    // A drafted N:M straight from customers to products: one hop, but it costs two.
    f.link('l_cust_prod', 'draft_customers_products', 'e_customers', 'e_products', {
      cardinality: 'N:M',
    }),
  ];

  return f.model({
    namespace: f.byId([
      f.namespace('ns_public', 'public', { isDefault: true }),
      f.namespace('ns_rep', 'reporting'),
    ]),
    area: f.byId([f.area('a_core', 'Core')]),
    entity: f.byId(entities),
    field: f.byId(fields),
    link: f.byId(links),
    constraint: f.byId([
      f.constraint('c_cust_pk', 'customers_pkey', 'e_customers', {
        kind: 'primaryKey',
        fieldIds: ['f_cust_id'],
      }),
      f.constraint('c_cust_email_uq', 'customers_email_key', 'e_customers', {
        kind: 'unique',
        fieldIds: ['f_cust_email'],
      }),
      f.constraint('c_item_pk', 'items_pkey', 'e_items', {
        kind: 'primaryKey',
        fieldIds: ['f_item_order', 'f_item_product'],
      }),
    ]),
    index: f.byId([
      f.index('ix_ord_cust', 'ix_orders_customer', 'e_orders', {
        isUnique: true,
        columns: [
          { ordinal: 0, fieldId: 'f_ord_customer', expression: null, role: 'key', engineProps: {} },
          { ordinal: 1, fieldId: 'f_ord_id', expression: null, role: 'include', engineProps: {} },
        ],
      }),
    ]),
  });
}

const model = fixture();
const ix = createIndex(model);

/** The scan the index exists to avoid — the helpers must agree with it. */
function naiveFields(entityId: Id): Field[] {
  return Object.values(model.objects.field)
    .filter((field) => field.entityId === entityId)
    .sort((a, b) => a.ordinal - b.ordinal || (a.id < b.id ? -1 : 1));
}

describe('createIndex / lookup', () => {
  it('finds an object of any type by id', () => {
    expect(get(model, 'entity', 'e_orders')?.name).toBe('orders');
    expect(get(model, 'field', 'f_cust_id')?.name).toBe('id');
    expect(get(model, 'entity', 'nope')).toBeUndefined();
    expect(getEntity(ix, 'e_items')?.name).toBe('items');
  });

  it('lists entities per namespace in name order and per area', () => {
    expect(entitiesOf(ix, 'ns_public').map((e) => e.name)).toEqual([
      'customers',
      'items',
      'orders',
      'products',
    ]);
    expect(entitiesOf(ix, 'ns_rep').map((e) => e.id)).toEqual(['e_isolated']);
    expect(entitiesOfArea(ix, 'a_core').map((e) => e.name)).toEqual(['customers', 'items']);
    expect(entitiesOfArea(ix, 'a_none')).toEqual([]);
  });

  it('resolves a qualified name through normalizeName', () => {
    expect(findEntityByName(ix, 'public', 'orders')?.id).toBe('e_orders');
    expect(findEntityByName(ix, 'public', 'Orders')).toBeUndefined();

    const folding = createIndex(model, { normalizeName: (n) => n.toLowerCase() });
    expect(findEntityByName(folding, 'PUBLIC', 'Orders')?.id).toBe('e_orders');
  });

  it('hands back copies, so a caller cannot corrupt the index', () => {
    const first = fieldsOf(ix, 'e_orders');
    first.reverse();
    expect(fieldsOf(ix, 'e_orders').map((field) => field.id)).toEqual([
      'f_ord_id',
      'f_ord_customer',
    ]);
  });

  it('memoizes one index per model object', () => {
    expect(indexOf(model)).toBe(indexOf(model));
    expect(indexOf(fixture())).not.toBe(indexOf(model));
  });
});

describe('fields', () => {
  it('orders by ordinal, not insertion, and agrees with a naive scan', () => {
    for (const entityId of Object.keys(model.objects.entity)) {
      expect(fieldsOf(ix, entityId)).toEqual(naiveFields(entityId));
    }
    expect(fieldsOf(ix, 'e_items').map((field) => field.name)).toEqual([
      'id',
      'order_id',
      'product_id',
    ]);
  });

  it('selects one sibling group, or the whole tree depth-first', () => {
    expect(fieldsOf(ix, 'e_customers', { parentFieldId: null }).map((x) => x.name)).toEqual([
      'id',
      'email',
      'address',
    ]);
    const addressGroup = fieldsOf(ix, 'e_customers', { parentFieldId: 'f_cust_addr' });
    expect(addressGroup.map((x) => x.name)).toEqual(['city', 'geo']);
    expect(fieldsOf(ix, 'e_customers', { recursive: true }).map((x) => x.name)).toEqual([
      'id',
      'email',
      'address',
      'city',
      'geo',
      'lat',
    ]);
  });

  it('reports depth and both paths', () => {
    expect(fieldDepth(ix, 'f_cust_id')).toBe(1);
    expect(fieldDepth(ix, 'f_addr_geo')).toBe(2);
    expect(fieldDepth(ix, 'f_geo_lat')).toBe(3);
    expect(fieldDepth(ix, 'f_missing')).toBe(0);

    expect(fieldPath(ix, 'f_geo_lat')).toEqual(['f_cust_addr', 'f_addr_geo', 'f_geo_lat']);
    expect(fieldNamePath(ix, 'f_geo_lat')).toEqual(['address', 'geo', 'lat']);
  });

  it('resolves a display path back to a field', () => {
    expect(resolveNamePath(ix, 'e_customers', ['address', 'geo', 'lat'])?.id).toBe('f_geo_lat');
    expect(resolveNamePath(ix, 'e_customers', ['address', 'nope'])).toBeUndefined();

    const folding = createIndex(model, { normalizeName: (n) => n.toLowerCase() });
    expect(resolveNamePath(folding, 'e_customers', ['ADDRESS', 'Geo'])?.id).toBe('f_addr_geo');
  });

  it('terminates on a parentFieldId cycle instead of hanging', () => {
    const looped = f.model({
      entity: f.byId([f.entity('e', 'e', 'ns')]),
      field: f.byId([
        f.field('f_a', 'a', 'e', { parentFieldId: 'f_b' }),
        f.field('f_b', 'b', 'e', { parentFieldId: 'f_a' }),
      ]),
    });
    const loopedIx = createIndex(looped);
    expect(fieldDepth(loopedIx, 'f_a')).toBeLessThanOrEqual(9);
    expect(fieldsOf(loopedIx, 'e', { recursive: true }).length).toBeLessThanOrEqual(16);
  });
});

describe('derived badges', () => {
  it('reads PK / UNIQUE / FK off the constraints, indexes and links', () => {
    expect(primaryKeyFields(ix, 'e_customers').map((x) => x.id)).toEqual(['f_cust_id']);
    expect(primaryKeyFields(ix, 'e_items').map((x) => x.id)).toEqual([
      'f_item_order',
      'f_item_product',
    ]);
    expect(primaryKeyFields(ix, 'e_products')).toEqual([]);

    expect(isPrimaryKey(ix, 'f_cust_id')).toBe(true);
    expect(isPrimaryKey(ix, 'f_cust_email')).toBe(false);

    expect(isUniqueField(ix, 'f_cust_email')).toBe(true);
    expect(isUniqueField(ix, 'f_ord_customer')).toBe(true); // key column of a unique index
    expect(isUniqueField(ix, 'f_ord_id')).toBe(false); // INCLUDE is payload, not key

    expect(isForeignKeyField(ix, 'f_ord_customer')).toBe(true);
    expect(isForeignKeyField(ix, 'f_cust_id')).toBe(false); // the referenced side is not an FK
  });

  it('lists constraints and indexes per entity', () => {
    expect(constraintsOf(ix, 'e_customers').map((c) => c.id)).toEqual([
      'c_cust_email_uq',
      'c_cust_pk',
    ]);
    expect(indexesOf(ix, 'e_orders').map((i) => i.id)).toEqual(['ix_ord_cust']);
    expect(indexesOf(ix, 'e_isolated')).toEqual([]);
  });
});

describe('graph', () => {
  it('lists links by direction and agrees with a naive scan', () => {
    const naiveTouching = (entityId: Id): Id[] =>
      Object.values(model.objects.link)
        .filter((l) => l.from.entityId === entityId || l.to.entityId === entityId)
        .map((l) => l.id)
        .sort();

    for (const entityId of Object.keys(model.objects.entity)) {
      expect(
        linksOf(ix, entityId)
          .map((l) => l.id)
          .sort(),
      ).toEqual(naiveTouching(entityId));
    }
    expect(linksOf(ix, 'e_orders', 'out').map((l) => l.id)).toEqual(['l_ord_cust']);
    expect(linksOf(ix, 'e_orders', 'in').map((l) => l.id)).toEqual(['l_item_ord']);
    expect(linksTouchingField(ix, 'f_cust_id').map((l) => l.id)).toEqual(['l_ord_cust']);
    expect(neighbours(ix, 'e_items').sort()).toEqual(['e_orders', 'e_products']);
    expect(neighbours(ix, 'e_isolated')).toEqual([]);
  });

  it('returns the cheapest join path first', () => {
    const paths = joinPaths(ix, 'e_customers', 'e_products');
    expect(paths.length).toBe(2);
    expect(paths[0]?.cost).toBe(2); // one N:M hop
    expect(paths[0]?.steps.map((s) => s.linkId)).toEqual(['l_cust_prod']);
    expect(paths[1]?.cost).toBe(3);
    expect(paths[1]?.steps.map((s) => s.linkId)).toEqual([
      'l_ord_cust',
      'l_item_ord',
      'l_item_prod',
    ]);
    expect(paths[1]?.steps.map((s) => s.direction)).toEqual(['reverse', 'reverse', 'forward']);
    expect(paths[1]?.steps[0]?.fieldPairs).toEqual([['f_cust_id', 'f_ord_customer']]);
  });

  it('honours maxDepth, limit and the allowed set, and terminates with no path', () => {
    expect(joinPaths(ix, 'e_customers', 'e_products', { maxDepth: 1 }).length).toBe(1);
    expect(joinPaths(ix, 'e_customers', 'e_products', { limit: 1 }).length).toBe(1);
    expect(
      joinPaths(ix, 'e_orders', 'e_products', {
        allowed: new Set(['e_orders', 'e_products']),
      }),
    ).toEqual([]);
    expect(joinPaths(ix, 'e_customers', 'e_isolated')).toEqual([]);
    expect(joinPaths(ix, 'e_customers', 'e_customers')).toEqual([]);
    expect(joinPaths(ix, 'e_customers', 'e_gone')).toEqual([]);
  });

  it('caches join paths without handing out its cached arrays', () => {
    const fresh = createIndex(model);
    const first = joinPaths(fresh, 'e_customers', 'e_products');
    expect(fresh.joinPathCache.size).toBe(1);
    first.length = 0;
    expect(joinPaths(fresh, 'e_customers', 'e_products').length).toBe(2);
  });

  it('orders entities parents-first for export', () => {
    const fresh = createIndex(model);
    const { order, cycles } = topologicalEntityOrder(fresh);
    // Tie-break is the logical key, so `ent:public.products` beats `ent:reporting.isolated`.
    expect(order).toEqual(['e_products', 'e_customers', 'e_orders', 'e_items', 'e_isolated']);
    expect(cycles).toEqual([]);
    expect(topologicalEntityOrder(fresh)).toBe(fresh.topoCache);
  });

  it('reports cycles instead of failing on them', () => {
    const cyclic = f.model({
      namespace: f.byId([f.namespace('ns', '', { isDefault: true })]),
      entity: f.byId([
        f.entity('e_a', 'a', 'ns'),
        f.entity('e_b', 'b', 'ns'),
        f.entity('e_self', 'self', 'ns'),
        f.entity('e_free', 'free', 'ns'),
      ]),
      link: f.byId([
        f.link('l_ab', '', 'e_a', 'e_b'),
        f.link('l_ba', '', 'e_b', 'e_a'),
        f.link('l_self', '', 'e_self', 'e_self'),
      ]),
    });
    const { order, cycles } = topologicalEntityOrder(createIndex(cyclic));
    expect(order.length).toBe(4);
    expect(order[0]).toBe('e_free');
    expect(cycles).toEqual([['e_a', 'e_b'], ['e_self']]);
  });
});
