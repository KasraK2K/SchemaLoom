import type { IrObject, IrObjectRef, SchemaModel } from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import { column, constraint, customType, index, indexColumn, model, ns, table } from './fixture-model.js';
import { extractReferences } from './references.js';

/**
 * `employees` holds the Restricted column the whole control exists for: doc 05's L3–L6
 * leak is a CHECK body reading `employees.salary` reaching a Viewer verbatim.
 */
const EMPLOYEES = table({ id: 'e1', name: 'employees' });
const ORDERS = table({ id: 'e2', name: 'orders' });

const FIELDS = [
  column({ id: 'f1', name: 'id', entityId: 'e1' }),
  column({ id: 'f2', name: 'salary', entityId: 'e1', isRestricted: true }),
  column({ id: 'f3', name: 'hired_on', entityId: 'e1' }),
  column({ id: 'f4', name: 'id', entityId: 'e2' }),
  column({ id: 'f5', name: 'discount', entityId: 'e2' }),
  column({ id: 'f6', name: 'deleted_at', entityId: 'e2' }),
];

function withObject(object: IrObject, kind: keyof SchemaModel['objects']): SchemaModel {
  const base = model({
    namespaces: [ns({ id: 'public', name: 'public', isDefault: true })],
    entities: [EMPLOYEES, ORDERS],
    fields: FIELDS,
  });
  return {
    ...base,
    objects: { ...base.objects, [kind]: { ...base.objects[kind], [object.id]: object } },
  };
}

function refsOf(object: IrObject, kind: keyof SchemaModel['objects']): readonly IrObjectRef[] {
  return extractReferences(object, null, withObject(object, kind));
}

const ids = (refs: readonly IrObjectRef[], type: IrObjectRef['type']): readonly string[] =>
  refs.filter((r) => r.type === type).map((r) => r.id);

describe('a column default', () => {
  it('finds the column the expression multiplies', () => {
    const annual = column({
      id: 'f7',
      name: 'annual',
      entityId: 'e1',
      engineProps: { default: 'salary * 12' },
    });
    expect(ids(refsOf(annual, 'field'), 'field')).toContain('f2');
  });

  it('finds a quoted reference too — folding a quoted name is a deliberate superset', () => {
    const annual = column({
      id: 'f7',
      name: 'annual',
      entityId: 'e1',
      engineProps: { default: '"Salary" * 12' },
    });
    expect(ids(refsOf(annual, 'field'), 'field')).toContain('f2');
  });

  it('resolves an unqualified name against the OWNING table only', () => {
    // `discount` is a column of orders, not of employees: an employees-owned expression
    // naming it must not pick up the orders column.
    const bonus = column({
      id: 'f7',
      name: 'bonus',
      entityId: 'e1',
      engineProps: { default: 'discount' },
    });
    expect(ids(refsOf(bonus, 'field'), 'field')).not.toContain('f5');
  });
});

describe('a generated column', () => {
  it('finds what it is generated from', () => {
    const tenure = column({
      id: 'f7',
      name: 'tenure',
      entityId: 'e1',
      engineProps: { generatedExpression: 'now() - hired_on' },
    });
    expect(ids(refsOf(tenure, 'field'), 'field')).toContain('f3');
  });
});

describe('an index', () => {
  it('finds the columns in a partial predicate', () => {
    const partial = index({
      id: 'i1',
      name: 'orders_live',
      entityId: 'e2',
      engineProps: { where: 'deleted_at IS NULL' },
    });
    expect(ids(refsOf(partial, 'index'), 'field')).toContain('f6');
  });

  it('finds the columns in an expression column — the case a per-column id array misses', () => {
    const expressionIndex = index({
      id: 'i1',
      name: 'employees_annual',
      entityId: 'e1',
      columns: [indexColumn({ ordinal: 0, expression: '(salary * 12)' })],
    });
    expect(ids(refsOf(expressionIndex, 'index'), 'field')).toContain('f2');
  });
});

describe('a CHECK constraint', () => {
  it('finds a qualified reference into another table', () => {
    const check = constraint({
      id: 'c1',
      name: 'discount_cap',
      entityId: 'e2',
      kind: 'check',
      engineProps: { expression: 'discount < employees.salary * 0.1' },
    });
    const refs = refsOf(check, 'constraint');
    expect(ids(refs, 'field')).toEqual(expect.arrayContaining(['f5', 'f2']));
    expect(ids(refs, 'entity')).toContain('e1');
  });

  it('resolves a schema-qualified three-part name', () => {
    const check = constraint({
      id: 'c1',
      entityId: 'e2',
      kind: 'check',
      engineProps: { expression: 'public.employees.salary > 0' },
    });
    const refs = refsOf(check, 'constraint');
    expect(ids(refs, 'field')).toContain('f2');
    expect(ids(refs, 'entity')).toContain('e1');
  });
});

describe('other expression carriers', () => {
  it('reads a view definition', () => {
    const view = table({
      id: 'e3',
      name: 'payroll',
      kind: 'view',
      engineProps: { viewDefinition: 'SELECT employees.salary FROM employees' },
    });
    const refs = refsOf(view, 'entity');
    expect(ids(refs, 'entity')).toContain('e1');
    expect(ids(refs, 'field')).toContain('f2');
  });

  it("reads a domain's CHECK bodies", () => {
    const domain = customType({
      id: 'ct1',
      name: 'capped',
      kind: 'domain',
      engineProps: { checks: ['VALUE < employees.salary'] },
    });
    expect(ids(refsOf(domain, 'customType'), 'field')).toContain('f2');
  });

  it('reads a partition key', () => {
    const partitioned = table({
      id: 'e1',
      name: 'employees',
      engineProps: { partitionBy: { strategy: 'range', expression: 'hired_on' } },
    });
    expect(ids(refsOf(partitioned, 'entity'), 'field')).toContain('f3');
  });
});

describe('it fails closed rather than crashing', () => {
  const owner = (props: Record<string, unknown>) =>
    column({ id: 'f7', name: 'x', entityId: 'e1', engineProps: props });

  it('returns nothing for an object with no expressions', () => {
    expect(refsOf(owner({}), 'field')).toEqual([]);
  });

  it('returns nothing for an unparseable expression', () => {
    expect(refsOf(owner({ default: '(((( ' }), 'field')).toEqual([]);
    expect(refsOf(owner({ default: "*/ '' )" }), 'field')).toEqual([]);
  });

  it('returns nothing when the expression names nothing in the model', () => {
    expect(refsOf(owner({ default: '42 + 7' }), 'field')).toEqual([]);
  });

  it('survives a prop of the wrong shape instead of throwing', () => {
    expect(refsOf(owner({ default: 42 }), 'field')).toEqual([]);
    expect(refsOf(owner({ checks: [null, 7] }), 'field')).toEqual([]);
    expect(refsOf(owner({ partitionBy: 'nonsense' }), 'field')).toEqual([]);
  });
});

describe('the result is a set, ordered', () => {
  it('reports each id once however many times the expression names it', () => {
    const check = constraint({
      id: 'c1',
      entityId: 'e1',
      kind: 'check',
      engineProps: { expression: 'salary > 0 AND salary < 1000 AND "salary" IS NOT NULL' },
    });
    expect(ids(refsOf(check, 'constraint'), 'field')).toEqual(['f2']);
  });

  it('is byte-ordered, so a persisted refs column is diff-stable', () => {
    const check = constraint({
      id: 'c1',
      entityId: 'e2',
      kind: 'check',
      engineProps: { expression: 'employees.hired_on < now() AND employees.salary > discount' },
    });
    const refs = refsOf(check, 'constraint');
    const keys = refs.map((r) => `${r.type}:${r.id}`);
    expect(keys).toEqual([...keys].sort());
  });
});
