import { parseEngineProps, type EnginePropsKind } from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import { postgresFacet } from './static.js';

const parse = (kind: EnginePropsKind, subKind: string | null, value: unknown) =>
  parseEngineProps(postgresFacet, kind, subKind, value);

const accepts = (kind: EnginePropsKind, subKind: string | null, value: unknown): void => {
  const result = parse(kind, subKind, value);
  expect(result.ok, JSON.stringify(result.ok ? [] : result.diagnostics)).toBe(true);
};

const rejects = (kind: EnginePropsKind, subKind: string | null, value: unknown): void => {
  expect(parse(kind, subKind, value).ok).toBe(false);
};

const ALL_KINDS: readonly EnginePropsKind[] = [
  'namespace',
  'entity',
  'field',
  'link',
  'index',
  'constraint',
  'customType',
  'indexColumn',
];

describe('field props', () => {
  it('accepts the full column vocabulary', () => {
    accepts('field', null, {
      default: "nextval('orders_id_seq')",
      identity: 'always',
      collation: 'en_US',
      storage: 'extended',
      compression: 'lz4',
    });
    accepts('field', null, { generatedExpression: 'price * quantity' });
    accepts('field', null, {});
  });

  it('rejects a value outside the enum', () => {
    rejects('field', null, { identity: 'sometimes' });
    rejects('field', null, { storage: 'compressed' });
  });

  it('rejects a wrongly typed value', () => {
    rejects('field', null, { default: 42 });
  });
});

describe('entity props vary by sub-kind', () => {
  it('a table takes storage options', () => {
    accepts('entity', 'table', {
      unlogged: true,
      tablespace: 'fast_ssd',
      partitionBy: { strategy: 'range', expression: 'created_at' },
      fillfactor: 70,
    });
  });

  it('a view takes its definition', () => {
    accepts('entity', 'view', { viewDefinition: 'SELECT * FROM orders', checkOption: 'cascaded' });
    accepts('entity', 'materializedView', { viewDefinition: 'SELECT 1', withData: false });
  });

  it('refuses a table property on a view, and the reverse', () => {
    rejects('entity', 'view', { unlogged: true });
    rejects('entity', 'table', { viewDefinition: 'SELECT 1' });
  });

  it('refuses a bad partition strategy', () => {
    rejects('entity', 'table', { partitionBy: { strategy: 'modulo', expression: 'id' } });
    rejects('entity', 'table', { partitionBy: { strategy: 'range' } });
  });

  it('bounds fillfactor', () => {
    rejects('entity', 'table', { fillfactor: 5 });
    rejects('entity', 'table', { fillfactor: 101 });
  });
});

describe('link props', () => {
  it('accepts referential actions', () => {
    accepts('link', 'foreignKey', {
      onDelete: 'cascade',
      onUpdate: 'noAction',
      deferrable: true,
      initiallyDeferred: true,
      matchFull: false,
    });
  });

  it('rejects the SQL spelling — the stored value is the camelCase id', () => {
    rejects('link', 'foreignKey', { onDelete: 'CASCADE' });
    rejects('link', 'foreignKey', { onDelete: 'set null' });
  });
});

describe('index props', () => {
  it('accepts a partial predicate and storage options', () => {
    accepts('index', null, {
      where: 'deleted_at IS NULL',
      fillfactor: 90,
      concurrently: true,
      tablespace: 'fast_ssd',
      nullsNotDistinct: true,
    });
  });

  it('puts the operator class on the COLUMN, where PostgreSQL puts it', () => {
    accepts('indexColumn', null, { opclass: 'jsonb_path_ops', nullsOrder: 'last' });
    rejects('index', null, { opclass: 'jsonb_path_ops' });
    rejects('indexColumn', null, { nullsOrder: 'middle' });
  });
});

describe('constraint props vary by kind', () => {
  it('a check carries an expression', () => {
    accepts('constraint', 'check', { expression: 'total >= 0', noInherit: true });
  });

  it('an exclusion carries an expression and its access method', () => {
    accepts('constraint', 'exclusion', { expression: 'during WITH &&', using: 'gist' });
  });

  it('a primary key does not carry an expression', () => {
    accepts('constraint', 'primaryKey', { deferrable: true, usingIndex: 'orders_pkey' });
    rejects('constraint', 'primaryKey', { expression: 'total >= 0' });
  });

  it('only a unique constraint takes NULLS NOT DISTINCT', () => {
    accepts('constraint', 'unique', { nullsNotDistinct: true });
    rejects('constraint', 'primaryKey', { nullsNotDistinct: true });
  });
});

describe('customType props vary by kind', () => {
  it('an enum carries ordered labels', () => {
    accepts('customType', 'enum', { labels: ['pending', 'paid', 'refunded'] });
    rejects('customType', 'enum', { labels: 'pending' });
    rejects('customType', 'enum', { labels: [''] });
  });

  it('a domain carries a base type and checks', () => {
    accepts('customType', 'domain', {
      baseType: 'integer',
      notNull: true,
      default: '0',
      checks: ['VALUE > 0'],
    });
    rejects('customType', 'domain', { labels: ['a'] });
  });

  it('a composite carries attributes', () => {
    accepts('customType', 'composite', {
      attributes: [
        { name: 'street', type: 'text' },
        { name: 'city', type: 'varchar(80)', collation: 'en_US' },
      ],
    });
    rejects('customType', 'composite', { attributes: [{ name: 'street' }] });
  });
});

describe('every schema is strict', () => {
  it.each(ALL_KINDS)('%s rejects an unknown key', (kind) => {
    rejects(kind, null, { somethingNobodyDeclared: 1 });
  });

  it('reports the offending path so the inspector can highlight it', () => {
    const result = parse('field', null, { identity: 'sometimes' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const [first] = result.diagnostics;
    expect(first?.code).toBe('postgresql.props-invalid');
    expect(first?.target.propPath).toEqual(['identity']);
    expect(first?.severity).toBe('error');
  });

  it('has a rendered template for the props-invalid code', () => {
    expect(postgresFacet.diagnosticMessages['postgresql.props-invalid']).toBeDefined();
  });
});
