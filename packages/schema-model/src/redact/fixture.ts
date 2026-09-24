import * as f from '../fixtures.js';
import type { SchemaModel } from '../model.js';

/**
 * Test-only. The spec's own workflow #2, small enough to reason about by eye:
 *
 * - `public` (default, `ns_1`) holds `invoices` and `employees`; `payroll_private`
 *   (`ns_2`) holds `payroll_runs`, and its NAME is the thing R-2 exists to blank.
 * - `employees.salary` (`fd_5`) is Restricted; `employees.bonus` (`fd_6`) is a perfectly
 *   visible column whose GENERATED expression names it — R-1's orthogonal case.
 * - `ix_1` is an ordinary index over the restricted column (∆21) and `ix_2` is an
 *   expression index over it that references no field id at all (L3), which is why
 *   `refs` exists.
 *
 * Ids here are OPAQUE on purpose. §7.10 accepts that a redacted model ships real ids
 * precisely because a cuid carries no name; an id like `fld_emp_salary` would hide every
 * name leak this fixture exists to catch behind an id the real system never emits.
 */
export const DEFAULT_NS = 'ns_1';

export function workflowModel(): SchemaModel {
  return f.model({
    namespace: f.byId([
      f.namespace(DEFAULT_NS, 'public', { isDefault: true }),
      f.namespace('ns_2', 'payroll_private'),
    ]),
    area: f.byId([
      f.area('ar_1', 'Billing'),
      f.area('ar_2', 'HR', { ordinal: 1 }),
      f.area('ar_3', 'Data Platform', { ordinal: 2 }),
    ]),
    customType: f.byId([f.customType('ct_1', 'currency_code', DEFAULT_NS)]),
    entity: f.byId([
      f.entity('en_1', 'invoices', DEFAULT_NS, {
        areaId: 'ar_1',
        position: { x: 10, y: 20 },
      }),
      f.entity('en_2', 'employees', DEFAULT_NS, {
        areaId: 'ar_2',
        engineProps: { tablespace: 'hr_fast' },
      }),
      f.entity('en_3', 'payroll_runs', 'ns_2', {
        areaId: 'ar_2',
        kind: 'materializedView',
        position: { x: 1240, y: 380 },
        width: 320,
        engineProps: { viewDefinition: 'SELECT salary FROM employees' },
      }),
    ]),
    field: f.byId([
      f.field('fd_1', 'id', 'en_1'),
      f.field('fd_2', 'employee_id', 'en_1', { ordinal: 1 }),
      f.field('fd_3', 'id', 'en_2'),
      f.field('fd_4', 'full_name', 'en_2', { ordinal: 1 }),
      f.field('fd_5', 'salary', 'en_2', {
        ordinal: 2,
        isRestricted: true,
        type: { name: 'numeric', args: [10, 2] },
        engineProps: { default: '0' },
      }),
      f.field('fd_6', 'bonus', 'en_2', {
        ordinal: 3,
        engineProps: { generatedExpression: 'salary * 0.1' },
        refs: { entityIds: [], fieldIds: ['fd_5'] },
      }),
      f.field('fd_7', 'id', 'en_3'),
    ]),
    constraint: f.byId([
      f.constraint('cs_1', 'employees_pkey', 'en_2', {
        kind: 'primaryKey',
        fieldIds: ['fd_3'],
        refs: { entityIds: ['en_2'], fieldIds: ['fd_3'] },
      }),
      f.constraint('cs_2', 'chk_employees_salary_positive', 'en_2', {
        fieldIds: ['fd_5'],
        engineProps: { expression: 'salary > 0' },
        refs: { entityIds: [], fieldIds: ['fd_5'] },
      }),
    ]),
    index: f.byId([
      f.index('ix_1', 'idx_employees_salary', 'en_2', {
        columns: [{ ordinal: 0, fieldId: 'fd_5', expression: null, role: 'key', engineProps: {} }],
        refs: { entityIds: [], fieldIds: ['fd_5'] },
      }),
      f.index('ix_2', 'idx_employees_annual_pay', 'en_2', {
        columns: [
          { ordinal: 0, fieldId: null, expression: '(salary * 12)', role: 'key', engineProps: {} },
        ],
        engineProps: { where: 'salary > 100000' },
        refs: { entityIds: [], fieldIds: ['fd_5'] },
      }),
    ]),
    link: f.byId([
      f.link('lk_1', 'fk_invoices_employee', 'en_1', 'en_2', {
        from: { entityId: 'en_1', fieldIds: ['fd_2'] },
        to: { entityId: 'en_2', fieldIds: ['fd_3'] },
        engineProps: { onDelete: 'cascade', constraintName: 'fk_invoices_employee' },
      }),
      f.link('lk_2', 'fk_payroll_runs_employee_salary', 'en_3', 'en_2', {
        from: { entityId: 'en_3', fieldIds: ['fd_7'] },
        to: { entityId: 'en_2', fieldIds: ['fd_3'] },
      }),
    ]),
  });
}
