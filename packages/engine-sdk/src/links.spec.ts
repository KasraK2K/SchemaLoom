import { describe, expect, it } from 'vitest';
import { checkLink } from './links.js';
import { defineCapabilities } from './define-capabilities.js';
import { FOREIGN_KEY_KIND, emptyModel, fixtureFacet, relationalInput } from './fixture-engine.js';
import type { Constraint, Entity, Field, SchemaModel, TypeRef } from './ir.js';
import type { EngineStaticFacet } from './definition.js';

function entity(id: string, namespaceId: string, kind = 'table'): Entity {
  return {
    id,
    name: id,
    version: 0,
    engineProps: {},
    namespaceId,
    kind,
    areaId: null,
    position: { x: 0, y: 0 },
    color: null,
    doc: null,
  };
}

function field(id: string, entityId: string, type: TypeRef): Field {
  return {
    id,
    name: id,
    version: 0,
    engineProps: {},
    entityId,
    parentFieldId: null,
    ordinal: 0,
    type,
    isNullable: false,
    isRestricted: false,
    isPii: false,
    isDeprecated: false,
    doc: null,
  };
}

function primaryKey(id: string, entityId: string, fieldIds: string[]): Constraint {
  return { id, name: id, version: 0, engineProps: {}, entityId, kind: 'primaryKey', fieldIds };
}

/** orders.customer_id (int4) -> customers.id (int4, PK). */
function baseModel(overrides: Partial<SchemaModel> = {}): SchemaModel {
  const model = emptyModel(overrides);
  return {
    ...model,
    objects: {
      ...model.objects,
      namespace: {
        ns1: { id: 'ns1', name: 'public', version: 0, engineProps: {}, isDefault: true },
        ns2: { id: 'ns2', name: 'audit', version: 0, engineProps: {}, isDefault: false },
      },
      entity: {
        orders: entity('orders', 'ns1'),
        customers: entity('customers', 'ns1'),
        elsewhere: entity('elsewhere', 'ns2'),
        report: entity('report', 'ns1', 'view'),
      },
      field: {
        'orders.customer_id': field('orders.customer_id', 'orders', { name: 'int4' }),
        'orders.note': field('orders.note', 'orders', { name: 'varchar', args: [255] }),
        'customers.id': field('customers.id', 'customers', { name: 'int4' }),
        'customers.region': field('customers.region', 'customers', { name: 'int4' }),
        'elsewhere.id': field('elsewhere.id', 'elsewhere', { name: 'int4' }),
      },
      constraint: {
        pk_customers: primaryKey('pk_customers', 'customers', ['customers.id']),
      },
      ...overrides.objects,
    },
  };
}

const source = { entityId: 'orders', fieldIds: ['orders.customer_id'] };
const target = { entityId: 'customers', fieldIds: ['customers.id'] };

describe('checkLink — declarative rules', () => {
  it('allows a compatible single-column foreign key and suggests N:1 from the target PK', () => {
    const result = checkLink({
      engine: fixtureFacet,
      model: baseModel(),
      linkKindId: 'foreignKey',
      source,
      target,
    });
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.linkKindId).toBe('foreignKey');
    expect(result.suggestedCardinality).toBe('N:1');
    expect(result.needsJunction).toBe(false);
  });

  it('picks the first accepting kind when the caller states none (the canvas drag case)', () => {
    const result = checkLink({
      engine: fixtureFacet,
      model: baseModel(),
      linkKindId: null,
      source,
      target,
    });
    expect(result.ok).toBe(true);
    expect(result.linkKindId).toBe('foreignKey');
  });

  it('refuses incompatible endpoint types', () => {
    const result = checkLink({
      engine: fixtureFacet,
      model: baseModel(),
      linkKindId: 'foreignKey',
      source: { entityId: 'orders', fieldIds: ['orders.note'] },
      target,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]?.code).toBe('link.typeMismatch');
    expect(result.reasons[0]?.vars).toEqual({ from: 'varchar(255)', to: 'int4' });
  });

  it('refuses mismatched arity', () => {
    const result = checkLink({
      engine: fixtureFacet,
      model: baseModel(),
      linkKindId: 'foreignKey',
      source,
      target: { entityId: 'customers', fieldIds: ['customers.id', 'customers.region'] },
    });
    expect(result.reasons[0]?.code).toBe('link.arityMismatch');
  });

  it('refuses a composite endpoint when the kind forbids it', () => {
    const engine: EngineStaticFacet = {
      ...fixtureFacet,
      capabilities: defineCapabilities(
        relationalInput({ linkKinds: [{ ...FOREIGN_KEY_KIND, compositeEndpoints: false }] }),
      ),
    };
    const result = checkLink({
      engine,
      model: baseModel(),
      linkKindId: 'foreignKey',
      source: { entityId: 'orders', fieldIds: ['orders.customer_id', 'orders.note'] },
      target: { entityId: 'customers', fieldIds: ['customers.id', 'customers.region'] },
    });
    expect(result.reasons[0]?.code).toBe('link.compositeNotAllowed');
  });

  it('refuses an entity kind the link kind does not allow', () => {
    const result = checkLink({
      engine: fixtureFacet,
      model: baseModel(),
      linkKindId: 'foreignKey',
      source,
      target: { entityId: 'report', fieldIds: ['customers.id'] },
    });
    expect(result.reasons[0]?.code).toBe('link.kindNotAllowed');
  });

  it('refuses a self reference only when the kind forbids it', () => {
    const selfEndpoints = {
      source: { entityId: 'customers', fieldIds: ['customers.region'] },
      target: { entityId: 'customers', fieldIds: ['customers.id'] },
    };
    expect(
      checkLink({
        engine: fixtureFacet,
        model: baseModel(),
        linkKindId: 'foreignKey',
        ...selfEndpoints,
      }).ok,
    ).toBe(true);

    const strict: EngineStaticFacet = {
      ...fixtureFacet,
      capabilities: defineCapabilities(
        relationalInput({ linkKinds: [{ ...FOREIGN_KEY_KIND, allowSelfReference: false }] }),
      ),
    };
    const result = checkLink({
      engine: strict,
      model: baseModel(),
      linkKindId: 'foreignKey',
      ...selfEndpoints,
    });
    expect(result.reasons[0]?.code).toBe('link.selfNotAllowed');
  });

  it('refuses a cross-namespace link when the kind requires one namespace', () => {
    const engine: EngineStaticFacet = {
      ...fixtureFacet,
      capabilities: defineCapabilities(
        relationalInput({ linkKinds: [{ ...FOREIGN_KEY_KIND, requireSameNamespace: true }] }),
      ),
    };
    const result = checkLink({
      engine,
      model: baseModel(),
      linkKindId: 'foreignKey',
      source,
      target: { entityId: 'elsewhere', fieldIds: ['elsewhere.id'] },
    });
    expect(result.reasons[0]?.code).toBe('link.crossNamespace');
    // The sentence says "schema", because that is what this engine calls a namespace.
    expect(result.reasons[0]?.vars).toEqual({ namespace: 'schema' });
  });

  it('refuses every link when the engine has no links at all', () => {
    const engine: EngineStaticFacet = {
      ...fixtureFacet,
      capabilities: defineCapabilities(
        relationalInput({ linkKinds: [], features: { indexes: true } }),
      ),
    };
    const result = checkLink({ engine, model: baseModel(), linkKindId: null, source, target });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]?.code).toBe('link.kindNotAllowed');
  });

  it('refuses an unknown link kind id', () => {
    const result = checkLink({
      engine: fixtureFacet,
      model: baseModel(),
      linkKindId: 'embeds',
      source,
      target,
    });
    expect(result.ok).toBe(false);
    expect(result.linkKindId).toBe('embeds');
  });

  it('skips type compatibility on an endpoint with no fields yet', () => {
    const result = checkLink({
      engine: fixtureFacet,
      model: baseModel(),
      linkKindId: 'foreignKey',
      source: { entityId: 'orders', fieldIds: [] },
      target: { entityId: 'customers', fieldIds: [] },
    });
    expect(result.ok).toBe(true);
    expect(result.suggestedCardinality).toBe('N:1');
  });
});

describe('checkLink — on a redacted model (§7.1)', () => {
  it('does not report an error about an object the viewer cannot see', () => {
    const base = baseModel();
    const hidden = base.objects.entity.customers;
    if (hidden === undefined) throw new Error('fixture');
    const model: SchemaModel = {
      ...base,
      redacted: true,
      objects: {
        ...base.objects,
        entity: { ...base.objects.entity, customers: { ...hidden, restricted: true } },
      },
    };
    const result = checkLink({
      engine: fixtureFacet,
      model,
      linkKindId: 'foreignKey',
      source,
      target,
    });
    expect(result.ok).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.suggestedCardinality).toBeNull();
    expect(result.allowedCardinalities).toEqual(['1:1', '1:N', 'N:1']);
  });

  it('tolerates an endpoint field that redaction dropped from the model entirely', () => {
    const base = baseModel();
    const { 'customers.id': _dropped, ...remaining } = base.objects.field;
    const model: SchemaModel = {
      ...base,
      redacted: true,
      objects: { ...base.objects, field: remaining },
    };
    expect(
      checkLink({ engine: fixtureFacet, model, linkKindId: 'foreignKey', source, target }).ok,
    ).toBe(true);
  });

  it('still applies the real rules on an unredacted model, which is what the server holds', () => {
    const result = checkLink({
      engine: fixtureFacet,
      model: baseModel(),
      linkKindId: 'foreignKey',
      source: { entityId: 'orders', fieldIds: ['orders.note'] },
      target,
    });
    expect(result.ok).toBe(false);
  });
});
