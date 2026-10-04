import type { Entity, Field, Link, SchemaModel } from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import { subsetModel } from './subset.js';

const entity = (id: string, restricted = false): Entity => ({
  id,
  name: id,
  version: 0,
  engineProps: {},
  namespaceId: 'ns',
  kind: 'table',
  areaId: null,
  position: { x: 0, y: 0 },
  color: null,
  doc: null,
  ...(restricted ? { restricted: true as const } : {}),
});

const field = (id: string, entityId: string): Field => ({
  id,
  name: id,
  version: 0,
  engineProps: {},
  entityId,
  parentFieldId: null,
  ordinal: 0,
  type: { name: 'integer' },
  isNullable: false,
  isRestricted: false,
  isPii: false,
  isDeprecated: false,
  doc: null,
});

const link = (id: string, from: string, to: string): Link => ({
  id,
  name: id,
  version: 0,
  engineProps: {},
  kind: 'foreignKey',
  from: { entityId: from, fieldIds: [`${from}.id`] },
  to: { entityId: to, fieldIds: [`${to}.id`] },
  cardinality: 'N:1',
});

/** orders → customers, orders → hidden, payments → orders; `other` stands alone. */
const model: SchemaModel = {
  irVersion: 1,
  projectId: 'p',
  engineId: 'postgresql',
  engineVersion: '16',
  redacted: true,
  objects: {
    area: {},
    namespace: {},
    customType: {},
    entity: Object.fromEntries(
      [
        entity('orders'),
        entity('customers'),
        entity('payments'),
        entity('other'),
        entity('hidden', true),
      ].map((e) => [e.id, e]),
    ),
    field: Object.fromEntries(
      ['orders', 'customers', 'payments', 'other'].map((e) => [`${e}.id`, field(`${e}.id`, e)]),
    ),
    constraint: {},
    index: {},
    link: Object.fromEntries(
      [
        link('fk_customer', 'orders', 'customers'),
        link('fk_hidden', 'orders', 'hidden'),
        link('fk_order', 'payments', 'orders'),
      ].map((l) => [l.id, l]),
    ),
  },
};

describe('subsetModel (Phase 18)', () => {
  it('keeps the selection and the tables it refers to, and nothing hidden', () => {
    const subset = subsetModel(model, ['orders', 'hidden', 'nope']);
    expect(Object.keys(subset.objects.entity).sort()).toEqual(['customers', 'orders']);
    expect(Object.keys(subset.objects.field).sort()).toEqual(['customers.id', 'orders.id']);
    // A table referring TO the selection is not pulled in, and neither is its link.
    expect(Object.keys(subset.objects.link)).toEqual(['fk_customer']);
    expect(subset.redacted).toBe(true);
  });

  it('is the whole model for an empty selection', () => {
    expect(subsetModel(model, [])).toBe(model);
  });
});
