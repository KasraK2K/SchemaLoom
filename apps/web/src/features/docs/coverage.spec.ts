import { describe, expect, it } from 'vitest';
import { CUSTOMERS, ORDERS, ORDER_ID, fixtureModel } from '@/features/canvas/model-fixture';
import { docCoverage } from './coverage';

describe('docCoverage (doc 05 L8)', () => {
  it('counts visible entities and fields, excluding stubs and masked fields from both sides', () => {
    const model = fixtureModel();
    // 2 real entities + 4 fields; the stub `e_secret` is in neither count.
    expect(docCoverage(model)).toEqual({ documented: 0, total: 6 });

    model.objects.entity[ORDERS] = {
      ...model.objects.entity[ORDERS]!,
      doc: { id: 'd1', excerpt: '' },
    };
    model.objects.field[ORDER_ID] = {
      ...model.objects.field[ORDER_ID]!,
      doc: { id: 'd2', excerpt: 'pk' },
    };
    // A masked slot never counts, even if a doc ref were somehow present.
    model.objects.field.f_masked = {
      ...model.objects.field[ORDER_ID],
      id: 'f_masked',
      entityId: CUSTOMERS,
      restricted: true,
      doc: { id: 'd3', excerpt: 'x' },
    };
    expect(docCoverage(model)).toEqual({ documented: 2, total: 6 });
  });
});
