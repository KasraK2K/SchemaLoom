import { checkLink, type LinkCheck, type LinkEndpoint } from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import { column, constraint, model, ns, table } from './fixture-model.js';
import { postgresFacet } from './static.js';

/**
 * Link legality is DATA — `capabilities.linkKinds` — evaluated by the SDK's shared
 * `checkLink`. There is no `linkRules` function on this engine, which is what keeps the
 * canvas's mid-drag answer and the server's on-write answer from drifting.
 */
const MODEL = model({
  namespaces: [
    ns({ id: 'public', name: 'public', isDefault: true }),
    ns({ id: 'archive', name: 'archive' }),
  ],
  entities: [
    table({ id: 'customers', name: 'customers' }),
    table({ id: 'orders', name: 'orders' }),
    table({ id: 'old_orders', name: 'old_orders', namespaceId: 'archive' }),
    table({ id: 'payroll', name: 'payroll', kind: 'view' }),
  ],
  fields: [
    column({ id: 'c_id', name: 'id', entityId: 'customers', type: { name: 'serial' } }),
    column({ id: 'c_alt', name: 'alt_id', entityId: 'customers', type: { name: 'uuid' } }),
    column({ id: 'o_id', name: 'id', entityId: 'orders', type: { name: 'integer' } }),
    column({ id: 'o_cust', name: 'customer_id', entityId: 'orders', type: { name: 'integer' } }),
    column({ id: 'o_alt', name: 'cust_alt', entityId: 'orders', type: { name: 'uuid' } }),
    column({ id: 'o_name', name: 'label', entityId: 'orders', type: { name: 'text' } }),
    column({ id: 'oo_cust', name: 'customer_id', entityId: 'old_orders', type: { name: 'integer' } }),
    column({ id: 'p_total', name: 'total', entityId: 'payroll', type: { name: 'integer' } }),
  ],
  constraints: [
    constraint({ id: 'pk_customers', entityId: 'customers', kind: 'primaryKey', fieldIds: ['c_id'] }),
    constraint({ id: 'uq_customers', entityId: 'customers', kind: 'unique', fieldIds: ['c_id', 'c_alt'] }),
  ],
});

const at = (entityId: string, ...fieldIds: string[]): LinkEndpoint => ({ entityId, fieldIds });

const check = (source: LinkEndpoint, target: LinkEndpoint, kind: string | null = 'foreignKey'): LinkCheck =>
  checkLink({ engine: postgresFacet, model: MODEL, linkKindId: kind, source, target });

const reasons = (result: LinkCheck): readonly string[] => result.reasons.map((r) => r.code);

describe('a normal foreign key', () => {
  it('is allowed, and suggests N:1 onto a unique target', () => {
    const result = check(at('orders', 'o_cust'), at('customers', 'c_id'));
    expect(result.ok).toBe(true);
    expect(result.linkKindId).toBe('foreignKey');
    expect(result.suggestedCardinality).toBe('N:1');
    expect(result.needsJunction).toBe(false);
  });

  it('accepts integer against the serial primary key it references', () => {
    expect(check(at('orders', 'o_cust'), at('customers', 'c_id')).ok).toBe(true);
  });

  it('is found without naming a kind — the canvas drag case', () => {
    const result = check(at('orders', 'o_cust'), at('customers', 'c_id'), null);
    expect(result.ok).toBe(true);
    expect(result.linkKindId).toBe('foreignKey');
  });

  it('allows a composite key', () => {
    const result = check(at('orders', 'o_cust', 'o_alt'), at('customers', 'c_id', 'c_alt'));
    expect(result.ok).toBe(true);
  });

  it('allows a self-reference', () => {
    expect(check(at('orders', 'o_cust'), at('orders', 'o_id')).ok).toBe(true);
  });

  it('allows a reference across schemas — PostgreSQL does', () => {
    expect(check(at('old_orders', 'oo_cust'), at('customers', 'c_id')).ok).toBe(true);
  });

  it('offers every cardinality the kind declares', () => {
    expect(check(at('orders', 'o_cust'), at('customers', 'c_id')).allowedCardinalities).toEqual([
      '1:1',
      '1:N',
      'N:1',
    ]);
  });
});

describe('an illegal foreign key is refused', () => {
  it('refuses incompatible column types', () => {
    const result = check(at('orders', 'o_name'), at('customers', 'c_id'));
    expect(result.ok).toBe(false);
    expect(reasons(result)).toContain('link.typeMismatch');
  });

  it('refuses a different number of columns on each side', () => {
    const result = check(at('orders', 'o_cust', 'o_alt'), at('customers', 'c_id'));
    expect(result.ok).toBe(false);
    expect(reasons(result)).toContain('link.arityMismatch');
  });

  it('refuses a view as the target — there is nothing to reference', () => {
    const result = check(at('orders', 'o_cust'), at('payroll', 'p_total'));
    expect(result.ok).toBe(false);
    expect(reasons(result)).toContain('link.kindNotAllowed');
  });

  it('refuses a view as the source', () => {
    expect(check(at('payroll', 'p_total'), at('customers', 'c_id')).ok).toBe(false);
  });

  it('refuses a link kind this engine does not have', () => {
    const result = check(at('orders', 'o_cust'), at('customers', 'c_id'), 'embeds');
    expect(result.ok).toBe(false);
    expect(reasons(result)).toContain('link.kindNotAllowed');
  });

  it('refuses an endpoint that is not in the model', () => {
    expect(check(at('nope', 'o_cust'), at('customers', 'c_id')).ok).toBe(false);
  });
});

describe('the rules are the capability data, not code', () => {
  it('declares the foreign key enforced and directed at field level', () => {
    const [kind] = postgresFacet.capabilities.linkKinds;
    expect(kind?.id).toBe('foreignKey');
    expect(kind?.enforced).toBe(true);
    expect(kind?.directed).toBe(true);
    expect(kind?.endpointLevel).toBe('field');
    expect(kind?.compositeEndpoints).toBe(true);
    expect(kind?.requireTypeCompatibility).toBe(true);
    expect(kind?.requireSameNamespace).toBe(false);
  });

  it('only lets tables be endpoints', () => {
    const [kind] = postgresFacet.capabilities.linkKinds;
    expect(kind?.allowedSourceEntityKinds).toEqual(['table']);
    expect(kind?.allowedTargetEntityKinds).toEqual(['table']);
  });
});
