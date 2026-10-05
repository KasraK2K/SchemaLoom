import { describe, expect, it } from 'vitest';
import { groupOps, moveOps, ungroupOps, updateAreaOp, nextOrdinal } from './area-ops';
import { AREA_BILLING, AREA_CRM, CUSTOMERS, ORDERS, SECRET, fixtureModel } from './model-fixture';

const model = fixtureModel();
const billing = model.objects.area[AREA_BILLING];
if (billing === undefined) throw new Error('fixture');

describe('group', () => {
  const area = { id: 'new', name: 'Area 1', color: 'area-3', ordinal: 2 };

  it('is one batch: create the area, then point each table at it with its version', () => {
    const ops = groupOps(model, [ORDERS, CUSTOMERS], area);
    expect(ops).toEqual([
      {
        op: 'create',
        type: 'area',
        object: { ...area, engineProps: {} },
      },
      {
        op: 'update',
        type: 'entity',
        id: ORDERS,
        expectedVersion: 1,
        patch: { areaId: 'new' },
      },
      {
        op: 'update',
        type: 'entity',
        id: CUSTOMERS,
        expectedVersion: 1,
        patch: { areaId: 'new' },
      },
    ]);
  });

  it('never writes a stub: the API would refuse it and the viewer cannot see it', () => {
    const ops = groupOps(model, [SECRET, ORDERS], area);
    expect(ops.map((op) => (op.op === 'update' ? op.id : op.op))).toEqual(['create', ORDERS]);
  });
});

describe('move', () => {
  it('writes only the tables whose area actually changes', () => {
    const ops = moveOps(model, [ORDERS, CUSTOMERS], AREA_BILLING);
    expect(ops.map((op) => op.id)).toEqual([CUSTOMERS]);
  });

  it('leaves every area with areaId null', () => {
    const ops = moveOps(model, [ORDERS], null);
    expect(ops).toHaveLength(1);
    expect(ops[0]?.patch).toEqual({ areaId: null });
  });

  it('is empty when nothing changes, so no batch and no revision', () => {
    expect(moveOps(model, [ORDERS], AREA_BILLING)).toEqual([]);
    expect(moveOps(model, [], null)).toEqual([]);
  });
});

describe('ungroup', () => {
  it('releases each member, keeps the tables, and deletes the area last', () => {
    const ops = ungroupOps(model, billing);
    expect(ops).toEqual([
      {
        op: 'update',
        type: 'entity',
        id: ORDERS,
        expectedVersion: 1,
        patch: { areaId: null },
      },
      { op: 'delete', type: 'area', id: AREA_BILLING, expectedVersion: billing.version },
    ]);
  });

  it('does not touch another area’s tables', () => {
    const crm = model.objects.area[AREA_CRM];
    if (crm === undefined) throw new Error('fixture');
    expect(ungroupOps(model, crm).map((op) => op.id)).toEqual([CUSTOMERS, AREA_CRM]);
  });
});

describe('area edits', () => {
  it('rename and recolour carry the version they were rendered from', () => {
    expect(updateAreaOp(billing, { name: 'Money' })).toEqual({
      op: 'update',
      type: 'area',
      id: AREA_BILLING,
      expectedVersion: billing.version,
      patch: { name: 'Money' },
    });
    expect(updateAreaOp(billing, { color: 'area-4' }).patch).toEqual({ color: 'area-4' });
  });

  it('a new area goes last in the legend', () => {
    expect(nextOrdinal([])).toBe(0);
    expect(nextOrdinal(Object.values(model.objects.area))).toBe(2);
  });
});
