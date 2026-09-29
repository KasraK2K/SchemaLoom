import type { EngineStaticFacet } from '@schemaloom/engine-sdk/ui';
import { createIndex, type SchemaModel } from '@schemaloom/schema-model';
import { beforeAll, describe, expect, it } from 'vitest';
import { engineFacets } from '@/engines';
import { areaColors } from './area-color';
import { buildEdges, buildNodes } from './graph';
import { NODE_HANDLE, fieldHandleId } from './handles';
import {
  AREA_BILLING,
  CUSTOMERS,
  CUSTOMER_ID,
  ORDERS,
  ORDER_CUSTOMER_ID,
  ORDER_ID,
  SECRET,
  fixtureModel,
} from './model-fixture';

let facet: EngineStaticFacet;
let model: SchemaModel;

beforeAll(async () => {
  await import('@/engines/register');
  facet = await engineFacets.load('postgresql');
  model = fixtureModel();
});

const nodesOf = () => {
  const index = createIndex(model);
  const nodes = buildNodes(index, facet, areaColors(Object.values(model.objects.area)));
  return new Map(nodes.map((node) => [node.id, node]));
};

describe('buildNodes', () => {
  it('derives PK / FK badges from constraints and links, not from field flags', () => {
    const orders = nodesOf().get(ORDERS);
    expect(orders?.data.badges.get(ORDER_ID)?.primaryKey).toBe(true);
    expect(orders?.data.badges.get(ORDER_ID)?.foreignKey).toBe(false);
    expect(orders?.data.badges.get(ORDER_CUSTOMER_ID)?.foreignKey).toBe(true);
    expect(orders?.data.badges.get(ORDER_CUSTOMER_ID)?.primaryKey).toBe(false);
  });

  it('marks a primary key as unique without a separate unique constraint', () => {
    expect(nodesOf().get(CUSTOMERS)?.data.badges.get(CUSTOMER_ID)?.unique).toBe(true);
  });

  it('resolves a type per field, once, so the renderer never touches the model', () => {
    const orders = nodesOf().get(ORDERS);
    expect(orders?.data.resolvedTypes.get(ORDER_ID)?.display).toContain('uuid');
  });

  it('colours a card by its area token', () => {
    expect(nodesOf().get(ORDERS)?.data.areaColor).toBe('var(--color-area-1)');
    expect(nodesOf().get(SECRET)?.data.areaColor).toBeNull();
  });

  it('keeps the real position of a stub so the diagram does not reflow per viewer', () => {
    expect(nodesOf().get(SECRET)?.position).toEqual({ x: 800, y: 0 });
  });

  it('derives nothing for a stub — no fields, no badges, no types', () => {
    const stub = nodesOf().get(SECRET);
    expect(stub?.data.fields).toEqual([]);
    expect(stub?.data.badges.size).toBe(0);
    expect(stub?.data.resolvedTypes.size).toBe(0);
  });

  it('carries the stub id but no name, and nothing reconstructs one', () => {
    // RECONCILIATION R-2: the id is REAL — links must point somewhere and "request access"
    // needs a target — while the name is blank and the namespace is the default one.
    // Whether the id ever reaches the screen is asserted in `redaction-render.spec.tsx`.
    const stub = nodesOf().get(SECRET);
    expect(stub?.data.entity.id).toBe(SECRET);
    expect(stub?.data.entity.name).toBe('');
    expect(stub?.data.entity.areaId).toBeNull();
  });
});

describe('buildEdges', () => {
  it('attaches a field-level link to its two field handles', () => {
    const edge = buildEdges(model, undefined).find((e) => e.id === 'l_orders_customers');
    expect(edge?.sourceHandle).toBe(fieldHandleId(ORDER_CUSTOMER_ID, 'source'));
    expect(edge?.targetHandle).toBe(fieldHandleId(CUSTOMER_ID, 'target'));
  });

  it('keeps drawing a redacted link, on the card-level handles', () => {
    // A badge-redacted link has had both endpoints cleared, so there is no field handle to
    // attach to. Dropping the edge would erase the one thing a stub communicates.
    const edge = buildEdges(model, undefined).find((e) => e.id === 'l_orders_secret');
    expect(edge).toBeDefined();
    expect(edge?.sourceHandle).toBe(NODE_HANDLE.source);
    expect(edge?.targetHandle).toBe(NODE_HANDLE.target);
    expect(edge?.data?.link.restricted).toBe(true);
  });

  it('takes its appearance from the engine, keyed by link kind', () => {
    const styles = {
      foreignKey: { sourceMarker: 'many', targetMarker: 'one', dashed: false },
    } as const;
    const edge = buildEdges(model, styles).find((e) => e.id === 'l_orders_customers');
    expect(edge?.data?.style?.targetMarker).toBe('one');
  });

  it('drops an edge whose endpoint entity is not in the model', () => {
    const broken: SchemaModel = {
      ...model,
      objects: { ...model.objects, entity: { [ORDERS]: model.objects.entity[ORDERS] ?? null } },
    } as SchemaModel;
    expect(buildEdges(broken, undefined)).toEqual([]);
  });

  it('names the area token deterministically across two builds', () => {
    expect(nodesOf().get(ORDERS)?.data.areaColor).toBe(nodesOf().get(ORDERS)?.data.areaColor);
    expect(areaColors(Object.values(model.objects.area)).get(AREA_BILLING)).toBe(
      'var(--color-area-1)',
    );
  });
});
