import type { Diagnostic, EngineContext } from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import {
  column,
  constraint,
  customType,
  index,
  indexColumn,
  link,
  model,
  ns,
  table,
  type ModelParts,
} from './fixture-model.js';
import { CODE, DIAGNOSTIC_MESSAGES } from './messages.js';
import { VALIDATOR } from './validator.js';

const CONTEXT: EngineContext = { projectId: 'p1', serverVersion: '16' };

function run(parts: ModelParts, objectIds?: readonly string[]): readonly Diagnostic[] {
  return VALIDATOR.validate({ model: model(parts), objectIds, context: CONTEXT });
}

const codes = (parts: ModelParts, objectIds?: readonly string[]): readonly string[] =>
  run(parts, objectIds).map((d) => d.code);

/** One table, one integer column, nothing wrong with it. */
const CLEAN: ModelParts = {
  entities: [table({ id: 'e1', name: 'orders' })],
  fields: [column({ id: 'f1', name: 'total', entityId: 'e1', type: { name: 'numeric', args: [10, 2] } })],
};

describe('a valid model produces nothing', () => {
  it('is silent', () => {
    expect(codes(CLEAN)).toEqual([]);
  });

  it('is silent for a fully furnished schema', () => {
    expect(
      codes({
        customTypes: [customType({ id: 'ct1', name: 'order_status', engineProps: { labels: ['new'] } })],
        entities: [table({ id: 'e1', name: 'orders' }), table({ id: 'e2', name: 'customers' })],
        fields: [
          column({ id: 'f1', name: 'id', entityId: 'e1', type: { name: 'integer' }, engineProps: { identity: 'always' } }),
          column({ id: 'f2', name: 'status', entityId: 'e1', type: { name: 'order_status', customTypeId: 'ct1' } }),
          column({ id: 'f3', name: 'customer_id', entityId: 'e1', type: { name: 'integer' } }),
          column({ id: 'f4', name: 'id', entityId: 'e2', type: { name: 'integer' } }),
        ],
        constraints: [
          constraint({ id: 'c1', entityId: 'e2', kind: 'primaryKey', fieldIds: ['f4'] }),
          constraint({ id: 'c2', entityId: 'e1', kind: 'check', engineProps: { expression: 'id > 0' } }),
        ],
        indexes: [
          index({ id: 'i1', name: 'orders_status', entityId: 'e1', columns: [indexColumn({ fieldId: 'f2' })] }),
        ],
        links: [
          link({ id: 'l1', from: { entityId: 'e1', fieldIds: ['f3'] }, to: { entityId: 'e2', fieldIds: ['f4'] } }),
        ],
      }),
    ).toEqual([]);
  });
});

describe('identifiers', () => {
  it('flags a name PostgreSQL would truncate, counting bytes', () => {
    const name = 'é'.repeat(40); // 80 bytes
    const found = run({ entities: [table({ id: 'e1', name })] });
    expect(found.map((d) => d.code)).toEqual([CODE.identifierTooLong]);
    expect(found[0]?.params.bytes).toBe(80);
    expect(found[0]?.severity).toBe('error');
  });

  it('warns about a reserved word rather than blocking it', () => {
    const found = run({ entities: [table({ id: 'e1', name: 'Order' })] });
    expect(found.map((d) => d.code)).toEqual([CODE.identifierReserved]);
    expect(found[0]?.severity).toBe('warning');
  });

  it('requires a name where one is required, and not where it is not', () => {
    expect(codes({ entities: [table({ id: 'e1', name: '' })] })).toEqual([CODE.identifierEmpty]);
    expect(
      codes({
        entities: [table({ id: 'e1', name: 'orders' })],
        constraints: [constraint({ id: 'c1', name: '', entityId: 'e1', kind: 'check', engineProps: { expression: 'true' } })],
      }),
    ).toEqual([]);
  });

  it('flags two tables whose names differ only in case', () => {
    const found = run({
      entities: [table({ id: 'e1', name: 'Orders' }), table({ id: 'e2', name: 'orders' })],
    });
    expect(found.map((d) => d.code)).toEqual([CODE.duplicateName, CODE.duplicateName]);
  });

  it('flags two columns of the same table, and allows the same name in another table', () => {
    expect(
      codes({
        entities: [table({ id: 'e1', name: 'orders' })],
        fields: [
          column({ id: 'f1', name: 'total', entityId: 'e1' }),
          column({ id: 'f2', name: 'TOTAL', entityId: 'e1' }),
        ],
      }),
    ).toEqual([CODE.duplicateName, CODE.duplicateName]);

    expect(
      codes({
        entities: [table({ id: 'e1', name: 'orders' }), table({ id: 'e2', name: 'invoices' })],
        fields: [
          column({ id: 'f1', name: 'total', entityId: 'e1' }),
          column({ id: 'f2', name: 'total', entityId: 'e2' }),
        ],
      }),
    ).toEqual([]);
  });
});

describe('types', () => {
  it('flags a type that does not exist', () => {
    const found = run({
      entities: [table({ id: 'e1', name: 'orders' })],
      fields: [column({ id: 'f1', name: 'x', entityId: 'e1', type: { name: 'hstore' } })],
    });
    expect(found.map((d) => d.code)).toEqual([CODE.typeUnknown]);
    expect(found[0]?.params.type).toBe('hstore');
  });

  it('flags a user type that has been deleted', () => {
    expect(
      codes({
        entities: [table({ id: 'e1', name: 'orders' })],
        fields: [
          column({ id: 'f1', name: 'x', entityId: 'e1', type: { name: 'order_status', customTypeId: 'gone' } }),
        ],
      }),
    ).toEqual([CODE.customTypeDangling]);
  });
});

describe('column flag combinations', () => {
  const field = (props: Record<string, unknown>, type = 'integer'): ModelParts => ({
    entities: [table({ id: 'e1', name: 'orders' })],
    fields: [column({ id: 'f1', name: 'x', entityId: 'e1', type: { name: type }, engineProps: props })],
  });

  it('refuses identity on a non-integer column', () => {
    const found = run(field({ identity: 'always' }, 'text'));
    expect(found.map((d) => d.code)).toEqual([CODE.identityNonInteger]);
    expect(found[0]?.target.propPath).toEqual(['identity']);
    expect(found[0]?.params.type).toBe('text');
  });

  it('accepts identity on smallint, integer and bigint', () => {
    for (const type of ['smallint', 'integer', 'bigint']) {
      expect(codes(field({ identity: 'byDefault' }, type))).toEqual([]);
    }
  });

  it('refuses identity together with a default', () => {
    expect(codes(field({ identity: 'always', default: '1' }))).toEqual([CODE.identityWithDefault]);
  });

  it('refuses a generated column with a default', () => {
    expect(codes(field({ generatedExpression: 'a * 2', default: '1' }))).toEqual([
      CODE.generatedWithDefault,
    ]);
  });

  it('refuses a generated column defined from another generated column', () => {
    const found = run({
      entities: [table({ id: 'e1', name: 'orders' })],
      fields: [
        column({ id: 'f1', name: 'net', entityId: 'e1', engineProps: { generatedExpression: 'gross * 2' } }),
        column({ id: 'f2', name: 'gross', entityId: 'e1', engineProps: { generatedExpression: 'base * 3' } }),
        column({ id: 'f3', name: 'base', entityId: 'e1' }),
      ],
    });
    expect(found.map((d) => d.code)).toEqual([CODE.generatedReferencesGenerated]);
    expect(found[0]?.target.id).toBe('f1');
  });
});

describe('constraints', () => {
  const orders = table({ id: 'e1', name: 'orders' });

  it('flags a CHECK with no body', () => {
    const found = run({ entities: [orders], constraints: [constraint({ id: 'c1', entityId: 'e1', kind: 'check' })] });
    expect(found.map((d) => d.code)).toEqual([CODE.constraintMissingExpression]);
    expect(found[0]?.target.propPath).toEqual(['expression']);
  });

  it('flags an EXCLUDE with no body, and leaves a primary key alone', () => {
    expect(
      codes({ entities: [orders], constraints: [constraint({ id: 'c1', entityId: 'e1', kind: 'exclusion' })] }),
    ).toEqual([CODE.constraintMissingExpression]);
    expect(
      codes({ entities: [orders], constraints: [constraint({ id: 'c1', entityId: 'e1', kind: 'primaryKey' })] }),
    ).toEqual([]);
  });

  it('flags a constraint over a column that no longer exists', () => {
    expect(
      codes({
        entities: [orders],
        constraints: [constraint({ id: 'c1', entityId: 'e1', kind: 'primaryKey', fieldIds: ['ghost'] })],
      }),
    ).toEqual([CODE.columnMissing]);
  });
});

describe('indexes', () => {
  const parts = (init: Parameters<typeof index>[0]): ModelParts => ({
    entities: [table({ id: 'e1', name: 'orders' })],
    fields: [column({ id: 'f1', name: 'total', entityId: 'e1' })],
    indexes: [index(init)],
  });

  it('flags an access method this engine does not have', () => {
    expect(codes(parts({ id: 'i1', name: 'i', entityId: 'e1', kind: 'bloom' }))).toEqual([
      CODE.indexKindUnknown,
    ]);
  });

  it('flags UNIQUE on an access method that cannot enforce it', () => {
    expect(codes(parts({ id: 'i1', name: 'i', entityId: 'e1', kind: 'hash', isUnique: true }))).toEqual([
      CODE.indexUniqueUnsupported,
    ]);
    expect(codes(parts({ id: 'i1', name: 'i', entityId: 'e1', kind: 'btree', isUnique: true }))).toEqual([]);
  });

  it('flags INCLUDE columns on an access method that cannot carry them', () => {
    const include = [indexColumn({ fieldId: 'f1' }), indexColumn({ ordinal: 1, fieldId: 'f1', role: 'include' })];
    expect(codes(parts({ id: 'i1', name: 'i', entityId: 'e1', kind: 'gin', columns: include }))).toEqual([
      CODE.indexIncludeUnsupported,
    ]);
    expect(codes(parts({ id: 'i1', name: 'i', entityId: 'e1', kind: 'btree', columns: include }))).toEqual([]);
  });

  it('flags an index over a column that no longer exists', () => {
    expect(
      codes(parts({ id: 'i1', name: 'i', entityId: 'e1', columns: [indexColumn({ fieldId: 'ghost' })] })),
    ).toEqual([CODE.columnMissing]);
  });
});

describe('custom types', () => {
  it('flags an enum with no labels', () => {
    expect(codes({ customTypes: [customType({ id: 'ct1', name: 'status', kind: 'enum' })] })).toEqual([
      CODE.enumNoLabels,
    ]);
  });

  it('leaves a domain alone', () => {
    expect(
      codes({
        customTypes: [customType({ id: 'ct1', name: 'positive', kind: 'domain', engineProps: { baseType: 'integer' } })],
      }),
    ).toEqual([]);
  });
});

describe('links that survived checkLink', () => {
  it('flags a bulk-imported link with incompatible endpoints', () => {
    const found = run({
      entities: [table({ id: 'e1', name: 'orders' }), table({ id: 'e2', name: 'customers' })],
      fields: [
        column({ id: 'f1', name: 'label', entityId: 'e1', type: { name: 'text' } }),
        column({ id: 'f2', name: 'id', entityId: 'e2', type: { name: 'integer' } }),
      ],
      links: [link({ id: 'l1', from: { entityId: 'e1', fieldIds: ['f1'] }, to: { entityId: 'e2', fieldIds: ['f2'] } })],
    });
    expect(found.map((d) => d.code)).toEqual([CODE.linkInvalid]);
    expect(found[0]?.params.reason).toBe('link.typeMismatch');
  });
});

describe('stale expression references', () => {
  it('flags an expression whose persisted refs no longer resolve', () => {
    const found = run({
      entities: [table({ id: 'e1', name: 'orders' })],
      constraints: [
        constraint({
          id: 'c1',
          entityId: 'e1',
          kind: 'check',
          engineProps: { expression: 'status <> 0' },
          refs: { entityIds: [], fieldIds: ['deleted_field'] },
        }),
      ],
    });
    expect(found.map((d) => d.code)).toEqual([CODE.expressionReferenceStale]);
    expect(found[0]?.params.count).toBe(1);
  });

  it('stays quiet when every persisted ref still resolves', () => {
    expect(
      codes({
        entities: [table({ id: 'e1', name: 'orders' })],
        fields: [column({ id: 'f1', name: 'status', entityId: 'e1' })],
        constraints: [
          constraint({
            id: 'c1',
            entityId: 'e1',
            kind: 'check',
            engineProps: { expression: 'status <> 0' },
            refs: { entityIds: ['e1'], fieldIds: ['f1'] },
          }),
        ],
      }),
    ).toEqual([]);
  });
});

describe('the contract around the results', () => {
  const BROKEN: ModelParts = {
    namespaces: [ns({ id: 'public', name: 'public', isDefault: true })],
    entities: [table({ id: 'e1', name: 'select' })],
    fields: [
      column({ id: 'f1', name: 'x', entityId: 'e1', type: { name: 'nope' } }),
      column({ id: 'f2', name: 'y', entityId: 'e1', type: { name: 'alsoNope' } }),
    ],
  };

  it('scopes to objectIds on a write', () => {
    expect(codes(BROKEN)).toHaveLength(3);
    expect(codes(BROKEN, ['f1'])).toEqual([CODE.typeUnknown]);
    expect(codes(BROKEN, [])).toEqual([]);
  });

  it('returns diagnostics in the SDK ordering — entity before field, then by id', () => {
    const found = run(BROKEN);
    expect(found.map((d) => d.target.id)).toEqual(['e1', 'f1', 'f2']);
  });

  it('carries structured params and never pre-rendered prose', () => {
    for (const diagnostic of run(BROKEN)) {
      expect(diagnostic.code.startsWith('postgresql.')).toBe(true);
      expect(DIAGNOSTIC_MESSAGES[diagnostic.code]).toBeDefined();
    }
  });

  it('has a message template for every code it can emit', () => {
    for (const code of Object.values(CODE)) {
      expect(DIAGNOSTIC_MESSAGES[code], code).toBeDefined();
    }
  });
});
