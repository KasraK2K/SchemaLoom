import { describe, expect, it } from 'vitest';
import { CUSTOMERS, ORDERS, ORDER_NOTE, SECRET, fixtureModel } from './model-fixture';
import { searchModel } from './search';

describe('searchModel', () => {
  it('ranks exact, prefix, substring, then doc excerpt; tables before columns', () => {
    const model = fixtureModel();
    model.objects.entity[CUSTOMERS] = {
      ...model.objects.entity[CUSTOMERS]!,
      doc: { id: 'd1', excerpt: 'People who place orders with us' },
    };
    const labels = searchModel(model, 'orders').map((h) => h.label);
    expect(labels).toEqual(['orders', 'customers']);
    expect(searchModel(model, 'ord')[0]).toMatchObject({ entityId: ORDERS, fieldId: null });
    expect(searchModel(model, 'orders')[1]?.snippet).toContain('place orders');
  });

  it('finds fields by name and doc, carrying their entity', () => {
    const model = fixtureModel();
    model.objects.field[ORDER_NOTE] = {
      ...model.objects.field[ORDER_NOTE]!,
      doc: { id: 'd2', excerpt: 'Free text from the checkout' },
    };
    expect(searchModel(model, 'checkout')).toEqual([
      {
        entityId: ORDERS,
        fieldId: ORDER_NOTE,
        label: 'orders.note',
        snippet: 'Free text from the checkout',
      },
    ]);
    expect(searchModel(model, 'customer_id').map((h) => h.label)).toEqual(['orders.customer_id']);
  });

  it('never matches a stub or a masked field, and ignores blank queries', () => {
    const model = fixtureModel();
    model.objects.entity[SECRET] = { ...model.objects.entity[SECRET]!, name: 'payroll' };
    model.objects.field.f_masked = {
      ...model.objects.field[ORDER_NOTE]!,
      id: 'f_masked',
      name: 'salary',
      restricted: true,
    };
    expect(searchModel(model, 'payroll')).toEqual([]);
    expect(searchModel(model, 'salary')).toEqual([]);
    expect(searchModel(model, '   ')).toEqual([]);
  });
});
