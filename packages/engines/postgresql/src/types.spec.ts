import type { TypeResolutionContext } from '@schemaloom/engine-sdk';
import { describe, expect, it } from 'vitest';
import { customType } from './fixture-model.js';
import { TYPE_CATALOG, TYPE_DESCRIPTORS } from './types.js';

const ORDER_STATUS = customType({ id: 'ct1', name: 'order_status', kind: 'enum' });
const ADDRESS = customType({ id: 'ct2', name: 'address', kind: 'composite' });
const POSITIVE_INT = customType({ id: 'ct3', name: 'positive_int', kind: 'domain' });

const ctx: TypeResolutionContext = {
  customTypes: [ORDER_STATUS, ADDRESS, POSITIVE_INT],
  namespaceName: 'public',
};

const empty: TypeResolutionContext = { customTypes: [], namespaceName: 'public' };

describe('built-in resolution', () => {
  it('resolves a plain type', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'integer' }, empty);
    expect(resolved.status).toBe('builtin');
    expect(resolved.category).toBe('numeric');
    expect(resolved.display).toBe('integer');
  });

  it('maps positional args onto named parameters', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'numeric', args: [10, 2] }, empty);
    expect(resolved.args).toEqual({ precision: 10, scale: 2 });
    expect(TYPE_CATALOG.format(resolved)).toBe('numeric(10,2)');
  });

  it('resolves a partially parameterised type', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'timestamptz', args: [3] }, empty);
    expect(resolved.args).toEqual({ precision: 3 });
    expect(resolved.display).toBe('timestamptz(3)');
  });

  it('keeps an unrecognised type verbatim instead of guessing', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'hstore' }, empty);
    expect(resolved.status).toBe('unknown');
    expect(resolved.display).toBe('hstore');
    expect(resolved.descriptor).toBeNull();
  });
});

describe('aliases round-trip to the canonical spelling', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['int4', 'integer'],
    ['int', 'integer'],
    ['int8', 'bigint'],
    ['int2', 'smallint'],
    ['character varying', 'varchar'],
    ['bpchar', 'char'],
    ['float8', 'double precision'],
    ['decimal', 'numeric'],
    ['bool', 'boolean'],
    ['timestamp with time zone', 'timestamptz'],
    ['time without time zone', 'time'],
    ['bit varying', 'varbit'],
  ];

  it.each(cases)('%s -> %s', (alias, canonical) => {
    const ref = TYPE_CATALOG.buildRef({ name: alias }, empty);
    expect(ref.name).toBe(canonical);
    expect(TYPE_CATALOG.format(TYPE_CATALOG.resolve(ref, empty))).toBe(canonical);
  });

  it('is case-insensitive and strips a catalog qualifier', () => {
    expect(TYPE_CATALOG.buildRef({ name: 'INTEGER' }, empty).name).toBe('integer');
    expect(TYPE_CATALOG.buildRef({ name: 'pg_catalog.int4' }, empty).name).toBe('integer');
  });

  it('carries the arguments through the alias', () => {
    const ref = TYPE_CATALOG.buildRef({ name: 'character varying(30)' }, empty);
    expect(ref).toEqual({ name: 'varchar', args: [30] });
    expect(TYPE_CATALOG.format(TYPE_CATALOG.resolve(ref, empty))).toBe('varchar(30)');
  });

  it('format(resolve(buildRef(x))) is stable under repetition', () => {
    const once = TYPE_CATALOG.format(
      TYPE_CATALOG.resolve(TYPE_CATALOG.buildRef({ name: 'numeric(12,4)' }, empty), empty),
    );
    const twice = TYPE_CATALOG.format(
      TYPE_CATALOG.resolve(TYPE_CATALOG.buildRef({ name: once }, empty), empty),
    );
    expect(twice).toBe(once);
  });
});

describe('arrays', () => {
  it('renders the bracket suffix per dimension', () => {
    expect(TYPE_CATALOG.resolve({ name: 'text', dimensions: 1 }, empty).display).toBe('text[]');
    expect(TYPE_CATALOG.resolve({ name: 'text', dimensions: 2 }, empty).display).toBe('text[][]');
  });

  it('parses the bracket suffix out of a written spelling', () => {
    expect(TYPE_CATALOG.buildRef({ name: 'varchar(20)[]' }, empty)).toEqual({
      name: 'varchar',
      args: [20],
      dimensions: 1,
    });
  });

  it('combines arguments and dimensions in the label', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'numeric', args: [10, 2], dimensions: 1 }, empty);
    expect(resolved.display).toBe('numeric(10,2)[]');
    expect(resolved.dimensions).toBe(1);
  });

  it('declares array support on the capabilities, derived from the catalog', () => {
    expect(TYPE_DESCRIPTORS.some((d) => d.supportsArray)).toBe(true);
  });

  it('marks the serial family as not array-able — it is a declaration, not a type', () => {
    for (const id of ['smallserial', 'serial', 'bigserial']) {
      expect(TYPE_DESCRIPTORS.find((d) => d.id === id)?.supportsArray).toBe(false);
    }
  });
});

describe('user-defined types', () => {
  it('resolves an enum by name', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'order_status' }, ctx);
    expect(resolved.status).toBe('user-defined');
    expect(resolved.customType?.id).toBe('ct1');
    expect(resolved.category).toBe('user-defined');
    expect(resolved.display).toBe('order_status');
  });

  it('buildRef binds the customTypeId', () => {
    expect(TYPE_CATALOG.buildRef({ name: 'address' }, ctx)).toEqual({
      name: 'address',
      customTypeId: 'ct2',
    });
  });

  it('resolves a user type by id even when the name has changed', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'old_name', customTypeId: 'ct3' }, ctx);
    expect(resolved.status).toBe('user-defined');
    expect(resolved.customType?.id).toBe('ct3');
  });

  it('reports a deleted user type as unknown rather than rebinding by name', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'order_status', customTypeId: 'gone' }, ctx);
    expect(resolved.status).toBe('unknown');
    expect(resolved.customType).toBeNull();
  });

  it('supports arrays of a user type', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'order_status', dimensions: 1 }, ctx);
    expect(resolved.display).toBe('order_status[]');
  });

  it('folds enums, domains and composites into the same picker', () => {
    const options = TYPE_CATALOG.listPickerOptions(ctx);
    const groups = new Map(options.map((o) => [o.label, o.group]));
    expect(groups.get('order_status')).toBe('Enums');
    expect(groups.get('positive_int')).toBe('Domains');
    expect(groups.get('address')).toBe('Composite types');
    expect(options.some((o) => o.group === 'Numeric' && o.customTypeId === null)).toBe(true);
  });
});

describe('link compatibility', () => {
  const resolve = (name: string, dimensions?: number) =>
    TYPE_CATALOG.resolve(dimensions === undefined ? { name } : { name, dimensions }, ctx);

  it('accepts the identical type', () => {
    expect(TYPE_CATALOG.areCompatible(resolve('uuid'), resolve('uuid'))).toBe(true);
  });

  it('accepts integer against the serial that generated it', () => {
    expect(TYPE_CATALOG.areCompatible(resolve('integer'), resolve('serial'))).toBe(true);
    expect(TYPE_CATALOG.areCompatible(resolve('bigint'), resolve('bigserial'))).toBe(true);
  });

  it('accepts within the text family', () => {
    expect(TYPE_CATALOG.areCompatible(resolve('text'), resolve('varchar'))).toBe(true);
  });

  it('rejects across families', () => {
    expect(TYPE_CATALOG.areCompatible(resolve('integer'), resolve('text'))).toBe(false);
    expect(TYPE_CATALOG.areCompatible(resolve('uuid'), resolve('integer'))).toBe(false);
  });

  it('rejects a scalar against an array of the same type', () => {
    expect(TYPE_CATALOG.areCompatible(resolve('integer'), resolve('integer', 1))).toBe(false);
  });

  it('matches two user types by id, not by name', () => {
    expect(TYPE_CATALOG.areCompatible(resolve('order_status'), resolve('order_status'))).toBe(true);
    expect(TYPE_CATALOG.areCompatible(resolve('order_status'), resolve('address'))).toBe(false);
  });
});

describe('the catalog covers the spec §3.4 built-in set', () => {
  const ids = new Set(TYPE_DESCRIPTORS.map((d) => d.id));

  it.each([
    'smallint',
    'integer',
    'bigint',
    'numeric',
    'real',
    'double precision',
    'text',
    'varchar',
    'char',
    'boolean',
    'date',
    'time',
    'timestamp',
    'timestamptz',
    'interval',
    'uuid',
    'json',
    'jsonb',
    'bytea',
    'inet',
    'cidr',
    'macaddr',
  ])('has %s', (id) => {
    expect(ids.has(id)).toBe(true);
  });

  it('has no duplicate id or alias — a collision would silently shadow a type', () => {
    const spellings = TYPE_DESCRIPTORS.flatMap((d) => [d.id, ...d.aliases]);
    expect(new Set(spellings).size).toBe(spellings.length);
  });
});
