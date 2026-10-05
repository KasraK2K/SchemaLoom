import type { EngineStaticFacet } from '@schemaloom/engine-sdk/ui';
import { createIndex, type SchemaModel } from '@schemaloom/schema-model';
import { beforeAll, describe, expect, it } from 'vitest';
import { engineFacets } from '@/engines';
import { areaColors, areaSlots } from './area-color';
import { buildAreaNodes, buildEdges, buildNodes } from './graph';
import { NODE_HANDLE, fieldHandleId } from './handles';
import {
  AREA_BILLING,
  AREA_CRM,
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
  const nodes = buildNodes(
    index,
    facet,
    areaColors(Object.values(model.objects.area)),
    areaSlots(Object.values(model.objects.area)),
  );
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

  it('rings a selected table in its area’s hue, via --sl-select', () => {
    const style = (id: string) =>
      (nodesOf().get(id)?.style as Record<string, string> | undefined)?.['--sl-select'];
    expect(style(ORDERS)).toBe('var(--area-hue-1)');
    expect(style(CUSTOMERS)).toBe('var(--area-hue-2)');
    // no area (and a stub): the theme's accent stays the ring
    expect(style(SECRET)).toBeUndefined();
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

describe('buildAreaNodes', () => {
  const areas = () => Object.values(model.objects.area);
  const slots = () => areaSlots(areas());
  const measured = () =>
    [...nodesOf().values()].map((node) => ({ ...node, measured: { width: 200, height: 100 } }));

  it('draws a card around its tables, 32 px out on every side, behind them', () => {
    const cards = buildAreaNodes(areas(), measured(), slots(), null);
    const billing = cards.find((card) => card.data.area.id === AREA_BILLING);
    // `orders` is at (0, 0), 200 x 100
    expect(billing?.position).toEqual({ x: -32, y: -32 });
    expect(billing?.width).toBe(264);
    expect(billing?.height).toBe(164);
    expect(billing?.zIndex).toBe(-1);
    expect(billing?.data.memberIds).toEqual([ORDERS]);
  });

  it('carries its own measured size, so React Flow counts it as initialised', () => {
    // `useNodesInitialized` waits for every node to be measured; a card is derived, never
    // measured by React Flow, and would otherwise hold back the first placement forever.
    const [card] = buildAreaNodes(areas(), measured(), slots(), null);
    expect(card?.measured).toEqual({ width: card?.width, height: card?.height });
  });

  it('is not selectable, draggable or connectable: it is not a table', () => {
    const [card] = buildAreaNodes(areas(), measured(), slots(), null);
    expect(card?.selectable).toBe(false);
    expect(card?.draggable).toBe(false);
    expect(card?.connectable).toBe(false);
  });

  it('follows its tables, because it is derived from where they are now', () => {
    const moved = measured().map((node) =>
      node.id === ORDERS ? { ...node, position: { x: 500, y: 300 } } : node,
    );
    const billing = buildAreaNodes(areas(), moved, slots(), null).find(
      (card) => card.data.area.id === AREA_BILLING,
    );
    expect(billing?.position).toEqual({ x: 468, y: 268 });
  });

  it('paints it from the stored colour token, fill and border', () => {
    const crm = buildAreaNodes(areas(), measured(), slots(), null).find(
      (card) => card.data.area.id === AREA_CRM,
    );
    expect(crm?.data.fill).toBe('var(--color-area-2)');
    expect(crm?.data.border).toBe('var(--color-area-2-border)');
  });

  it('highlights only the card a dragged table is over', () => {
    const cards = buildAreaNodes(areas(), measured(), slots(), AREA_CRM);
    expect(cards.map((card) => [card.data.area.id, card.data.highlighted])).toEqual([
      [AREA_BILLING, false],
      [AREA_CRM, true],
    ]);
  });

  it('does not draw a card none of whose tables is measured yet', () => {
    expect(buildAreaNodes(areas(), [...nodesOf().values()], slots(), null)).toEqual([]);
  });

  it('does not draw an empty card', () => {
    const only = measured().filter((node) => node.id !== CUSTOMERS);
    const cards = buildAreaNodes(areas(), only, slots(), null);
    expect(cards.map((card) => card.data.area.id)).toEqual([AREA_BILLING]);
  });

  it('draws a card from the tables the viewer can see, never from a stub', () => {
    const stubbed = measured().map((node) =>
      node.id === SECRET
        ? {
            ...node,
            position: { x: 5000, y: 5000 },
            data: { ...node.data, entity: { ...node.data.entity, areaId: AREA_BILLING } },
          }
        : node,
    );
    const billing = buildAreaNodes(areas(), stubbed, slots(), null).find(
      (card) => card.data.area.id === AREA_BILLING,
    );
    expect(billing?.width).toBe(264);
    expect(billing?.data.memberIds).toEqual([ORDERS]);
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
