import { describe, expect, it } from 'vitest';

import * as f from './fixtures.js';
import { byLogicalKey, logicalKey } from './logical-key.js';
import type { NormalizeName } from './normalize-name.js';

const lower: NormalizeName = (s) => s.toLowerCase();

/**
 * public.orders(id, address{geo{lat}}, customer_id, tenant_id)
 * public.customers(id, tenant_id)
 */
const base = f.model({
  area: f.byId([f.area('a1', 'Billing')]),
  namespace: f.byId([f.namespace('n1', 'public', { isDefault: true })]),
  customType: f.byId([f.customType('t1', 'order_status', 'n1')]),
  entity: f.byId([f.entity('e1', 'orders', 'n1'), f.entity('e2', 'customers', 'n1')]),
  field: f.byId([
    f.field('f_id', 'id', 'e1'),
    f.field('f_addr', 'address', 'e1', { ordinal: 1 }),
    f.field('f_geo', 'geo', 'e1', { parentFieldId: 'f_addr' }),
    f.field('f_lat', 'lat', 'e1', { parentFieldId: 'f_geo' }),
    f.field('f_cust', 'customer_id', 'e1', { ordinal: 2 }),
    f.field('f_tenant', 'tenant_id', 'e1', { ordinal: 3 }),
    f.field('f_cid', 'id', 'e2'),
    f.field('f_ctenant', 'tenant_id', 'e2', { ordinal: 1 }),
  ]),
});

describe('logicalKey — the shapes §6.1 names', () => {
  it('area: name alone, no parent scope', () => {
    expect(logicalKey(base, 'area', 'a1')).toBe('area:Billing');
  });

  it('namespace', () => {
    expect(logicalKey(base, 'namespace', 'n1')).toBe('ns:public');
  });

  it('customType: namespace-scoped', () => {
    expect(logicalKey(base, 'customType', 't1')).toBe('type:public.order_status');
  });

  it('entity: namespace-scoped', () => {
    expect(logicalKey(base, 'entity', 'e1')).toBe('ent:public.orders');
  });

  it('field: full dotted path from the entity', () => {
    expect(logicalKey(base, 'field', 'f_id')).toBe('fld:public.orders.id');
    expect(logicalKey(base, 'field', 'f_lat')).toBe('fld:public.orders.address.geo.lat');
  });

  it('constraint: kind plus participating field names', () => {
    const m = f.model({
      ...base.objects,
      constraint: f.byId([
        f.constraint('c1', 'orders_pkey', 'e1', { kind: 'primaryKey', fieldIds: ['f_id'] }),
      ]),
    });
    expect(logicalKey(m, 'constraint', 'c1')).toBe('con:public.orders#primaryKey(id)');
  });

  it('index: kept on its name — two indexes on one column are different objects', () => {
    const m = f.model({
      ...base.objects,
      index: f.byId([f.index('i1', 'idx_orders_customer', 'e1')]),
    });
    expect(logicalKey(m, 'index', 'i1')).toBe('idx:public.orders#idx_orders_customer');
  });

  it('link: both endpoints, composite fields in pairing order', () => {
    const m = f.model({
      ...base.objects,
      link: f.byId([
        f.link('l1', 'fk_orders_customer', 'e1', 'e2', {
          from: { entityId: 'e1', fieldIds: ['f_cust', 'f_tenant'] },
          to: { entityId: 'e2', fieldIds: ['f_cid', 'f_ctenant'] },
        }),
      ]),
    });
    expect(logicalKey(m, 'link', 'l1')).toBe(
      'lnk:public.orders(customer_id,tenant_id)->public.customers(id,tenant_id)',
    );
  });

  it('link: a self-reference keys to the same entity on both sides', () => {
    const m = f.model({
      ...base.objects,
      link: f.byId([
        f.link('l1', 'fk_parent', 'e1', 'e1', {
          from: { entityId: 'e1', fieldIds: ['f_cust'] },
          to: { entityId: 'e1', fieldIds: ['f_id'] },
        }),
      ]),
    });
    expect(logicalKey(m, 'link', 'l1')).toBe('lnk:public.orders(customer_id)->public.orders(id)');
  });
});

describe('logicalKey — injectivity, the cases revision 1 broke', () => {
  it('two fieldless CHECKs on one table do not collide (they fall back to the name)', () => {
    const m = f.model({
      ...base.objects,
      constraint: f.byId([
        f.constraint('c1', 'orders_total_positive', 'e1'),
        f.constraint('c2', 'orders_ship_after_order', 'e1'),
      ]),
    });
    const k1 = logicalKey(m, 'constraint', 'c1');
    const k2 = logicalKey(m, 'constraint', 'c2');
    expect(k1).toBe('con:public.orders#check@orders_total_positive');
    expect(k1).not.toBe(k2);
  });

  it('two UNNAMED fieldless CHECKs fall back to the id', () => {
    const m = f.model({
      ...base.objects,
      constraint: f.byId([f.constraint('c1', '', 'e1'), f.constraint('c2', '', 'e1')]),
    });
    expect(logicalKey(m, 'constraint', 'c1')).toBe('con:public.orders#check#c1');
    expect(logicalKey(m, 'constraint', 'c1')).not.toBe(logicalKey(m, 'constraint', 'c2'));
  });

  it('a column-bearing constraint is NOT name-keyed — auto-named matches hand-named', () => {
    const auto = f.model({
      ...base.objects,
      constraint: f.byId([
        f.constraint('c1', 'orders_pkey', 'e1', { kind: 'primaryKey', fieldIds: ['f_id'] }),
      ]),
    });
    const hand = f.model({
      ...base.objects,
      constraint: f.byId([
        f.constraint('c9', 'pk_orders', 'e1', { kind: 'primaryKey', fieldIds: ['f_id'] }),
      ]),
    });
    expect(logicalKey(auto, 'constraint', 'c1')).toBe(logicalKey(hand, 'constraint', 'c9'));
  });

  it('two draft links between the same pair do not collide (N:M before a junction)', () => {
    const m = f.model({
      ...base.objects,
      link: f.byId([
        f.link('l1', 'fk_draft', 'e1', 'e2', { cardinality: 'N:M' }),
        f.link('l2', 'fk_other', 'e1', 'e2', { cardinality: 'N:M' }),
      ]),
    });
    expect(logicalKey(m, 'link', 'l1')).toBe('lnk:public.orders()->public.customers()@fk_draft');
    expect(logicalKey(m, 'link', 'l1')).not.toBe(logicalKey(m, 'link', 'l2'));
  });

  it('two UNNAMED draft links between the same pair fall back to the id', () => {
    const m = f.model({
      ...base.objects,
      link: f.byId([f.link('l1', '', 'e1', 'e2'), f.link('l2', '', 'e1', 'e2')]),
    });
    expect(logicalKey(m, 'link', 'l1')).toBe('lnk:public.orders()->public.customers()#l1');
    expect(logicalKey(m, 'link', 'l1')).not.toBe(logicalKey(m, 'link', 'l2'));
  });

  it('two stubbed entities in one namespace do not collide (RECONCILIATION R-1 flag)', () => {
    const m = f.model({
      ...base.objects,
      entity: f.byId([
        f.entity('e1', '', 'n1', { kind: '', restricted: true }),
        f.entity('e2', '', 'n1', { kind: '', restricted: true }),
      ]),
    });
    expect(logicalKey(m, 'entity', 'e1')).toBe('ent:#e1');
    expect(logicalKey(m, 'entity', 'e1')).not.toBe(logicalKey(m, 'entity', 'e2'));
  });

  it('propsRedacted alone does NOT force the stub key — the object is still visible', () => {
    const m = f.model({
      ...base.objects,
      entity: f.byId([f.entity('e1', 'orders', 'n1', { propsRedacted: true })]),
    });
    expect(logicalKey(m, 'entity', 'e1')).toBe('ent:public.orders');
  });

  it('a name cannot forge a separator', () => {
    const m = f.model({
      namespace: f.byId([f.namespace('n1', 'public'), f.namespace('n2', 'public.orders')]),
      entity: f.byId([f.entity('e1', 'orders', 'n1'), f.entity('e2', 'x', 'n2')]),
    });
    expect(logicalKey(m, 'entity', 'e1')).not.toBe(logicalKey(m, 'entity', 'e2'));
    expect(logicalKey(m, 'namespace', 'n2')).toBe('ns:public%2Eorders');
  });

  it('a name cannot forge the link arrow or the field separator', () => {
    const m = f.model({
      namespace: f.byId([f.namespace('n1', 'a')]),
      entity: f.byId([f.entity('e1', 'b->c', 'n1'), f.entity('e2', 'd,e', 'n1')]),
    });
    expect(logicalKey(m, 'entity', 'e1')).toBe('ent:a.b-%3Ec');
    expect(logicalKey(m, 'entity', 'e2')).toBe('ent:a.d%2Ce');
  });

  it('a dangling parent reference keys to the parent id rather than throwing', () => {
    const m = f.model({ entity: f.byId([f.entity('e1', 'orders', 'gone')]) });
    expect(logicalKey(m, 'entity', 'e1')).toBe('ent:#gone.orders');
  });

  it('an id with no object behind it keys as a stub', () => {
    expect(logicalKey(base, 'entity', 'nope')).toBe('ent:#nope');
  });
});

describe('logicalKey — normalizeName (§6.3)', () => {
  it('folds every name segment, so an imported `Orders` matches the live `orders`', () => {
    const live = f.model({
      namespace: f.byId([f.namespace('n1', 'public')]),
      entity: f.byId([f.entity('e1', 'orders', 'n1')]),
      field: f.byId([f.field('f1', 'id', 'e1')]),
    });
    const imported = f.model({
      namespace: f.byId([f.namespace('n9', 'PUBLIC')]),
      entity: f.byId([f.entity('e9', 'Orders', 'n9')]),
      field: f.byId([f.field('f9', 'ID', 'e9')]),
    });
    expect(logicalKey(imported, 'entity', 'e9', lower)).toBe(
      logicalKey(live, 'entity', 'e1', lower),
    );
    expect(logicalKey(imported, 'field', 'f9', lower)).toBe(logicalKey(live, 'field', 'f1', lower));
  });

  it('defaults to identity — without an engine, nothing is folded', () => {
    const m = f.model({
      namespace: f.byId([f.namespace('n1', 'public')]),
      entity: f.byId([f.entity('e1', 'Orders', 'n1')]),
    });
    expect(logicalKey(m, 'entity', 'e1')).toBe('ent:public.Orders');
  });

  it('is stable — the same model and normalizer give the same key every call', () => {
    expect(logicalKey(base, 'field', 'f_lat')).toBe(logicalKey(base, 'field', 'f_lat'));
  });
});

describe('byLogicalKey', () => {
  it('indexes a whole collection', () => {
    const map = byLogicalKey(base, 'entity');
    expect([...map.keys()].sort()).toEqual(['ent:public.customers', 'ent:public.orders']);
    expect(map.get('ent:public.orders')?.id).toBe('e1');
  });

  it('is injective over a valid model, so nothing is lost', () => {
    const map = byLogicalKey(base, 'field');
    expect(map.size).toBe(Object.keys(base.objects.field).length);
  });

  it('applies the normalizer to the keys', () => {
    const m = f.model({
      namespace: f.byId([f.namespace('n1', 'PUBLIC')]),
      entity: f.byId([f.entity('e1', 'Orders', 'n1')]),
    });
    expect([...byLogicalKey(m, 'entity', lower).keys()]).toEqual(['ent:public.orders']);
  });
});
