import { describe, expect, it } from 'vitest';
import { column, model, table } from './fixture-model.js';
import { extractReferences } from './references.js';

/** The superset rule's one job: a Restricted column named anywhere is reported. */
describe('extractReferences (MySQL)', () => {
  it('counts a view’s unqualified columns as columns of the tables it reads', () => {
    const employees = table({ id: 'e1', name: 'employees' });
    const view = table({
      id: 'v1',
      name: 'payroll',
      kind: 'view',
      engineProps: { viewDefinition: 'select `id`, salary from employees' },
    });
    const m = model({
      entities: [employees, view],
      fields: [
        column({ id: 'f1', name: 'id', entityId: 'e1' }),
        column({ id: 'f2', name: 'salary', entityId: 'e1', isRestricted: true }),
      ],
    });
    const fields = extractReferences(view, 'view', m)
      .filter((r) => r.type === 'field')
      .map((r) => r.id);
    expect(fields).toEqual(['f1', 'f2']);
  });
});
