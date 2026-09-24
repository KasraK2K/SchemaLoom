import { describe, expect, it } from 'vitest';
import { TYPE_CATALOG } from './fixture-engine.js';
import type { CustomType } from './ir.js';
import type { TypeResolutionContext } from './type-catalog.js';

function customType(id: string, name: string, kind: string): CustomType {
  return { id, name, version: 0, engineProps: {}, namespaceId: 'ns1', kind };
}

const orderStatus = customType('ct1', 'order_status', 'enum');
const positiveInt = customType('ct2', 'positive_int', 'domain');
const internalOnly = customType('ct3', 'internal_blob', 'composite');

const ctx: TypeResolutionContext = {
  customTypes: [orderStatus, positiveInt, internalOnly],
  namespaceName: 'public',
};

describe('createTypeCatalog — resolution', () => {
  it('resolves a builtin by id', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'int4' }, ctx);
    expect(resolved.status).toBe('builtin');
    expect(resolved.descriptor?.id).toBe('int4');
    expect(resolved.display).toBe('int4');
    expect(resolved.category).toBe('numeric');
  });

  it('resolves a builtin by alias, case-insensitively', () => {
    expect(TYPE_CATALOG.resolve({ name: 'Character Varying' }, ctx).descriptor?.id).toBe('varchar');
  });

  it('maps positional args onto a parameterised type', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'numeric', args: [10, 2] }, ctx);
    expect(resolved.args).toEqual({ precision: 10, scale: 2 });
    expect(resolved.display).toBe('numeric(10,2)');
  });

  it('keeps a non-numeric first argument, so format round-trips the stored ref', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'geometry', args: ['Point', 4326] }, ctx);
    expect(resolved.args).toEqual({ subtype: 'Point', srid: 4326 });
    expect(TYPE_CATALOG.format(resolved)).toBe('geometry(Point,4326)');
  });

  it('renders array dimensions with the engine syntax', () => {
    expect(TYPE_CATALOG.resolve({ name: 'int4', dimensions: 2 }, ctx).display).toBe('int4[][]');
  });

  it('resolves a user-defined type by customTypeId', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'order_status', customTypeId: 'ct1' }, ctx);
    expect(resolved.status).toBe('user-defined');
    expect(resolved.customType).toBe(orderStatus);
    expect(resolved.category).toBe('user-defined');
    expect(resolved.display).toBe('order_status');
  });

  it('resolves a user-defined type by name when no id is stored', () => {
    expect(TYPE_CATALOG.resolve({ name: 'positive_int' }, ctx).customType).toBe(positiveInt);
  });

  it('reports a dangling customTypeId as unknown rather than rebinding by name', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'order_status', customTypeId: 'deleted' }, ctx);
    expect(resolved.status).toBe('unknown');
    expect(resolved.customType).toBeNull();
  });

  it('survives an unrecognised type verbatim', () => {
    const resolved = TYPE_CATALOG.resolve({ name: 'hstore', args: [1] }, ctx);
    expect(resolved.status).toBe('unknown');
    expect(resolved.display).toBe('hstore(1)');
  });

  it('normalizeAliases runs before descriptor matching', () => {
    expect(TYPE_CATALOG.resolve({ name: 'serial' }, ctx).descriptor?.id).toBe('int4');
  });
});

describe('createTypeCatalog — buildRef', () => {
  it('canonicalises a spelling, its args and its array suffix', () => {
    expect(TYPE_CATALOG.buildRef({ name: 'Character Varying(30)' }, ctx)).toEqual({
      name: 'varchar',
      args: [30],
    });
    expect(TYPE_CATALOG.buildRef({ name: 'public.int4[]' }, ctx)).toEqual({
      name: 'int4',
      dimensions: 1,
    });
  });

  it('attaches customTypeId for a user type', () => {
    expect(TYPE_CATALOG.buildRef({ name: 'order_status' }, ctx)).toEqual({
      name: 'order_status',
      customTypeId: 'ct1',
    });
  });

  it('format(resolve(buildRef(x))) is stable under repetition', () => {
    const once = TYPE_CATALOG.format(
      TYPE_CATALOG.resolve(TYPE_CATALOG.buildRef({ name: 'numeric(10,2)' }, ctx), ctx),
    );
    const twice = TYPE_CATALOG.format(
      TYPE_CATALOG.resolve(TYPE_CATALOG.buildRef({ name: once }, ctx), ctx),
    );
    expect(once).toBe('numeric(10,2)');
    expect(twice).toBe(once);
  });
});

describe('createTypeCatalog — compatibility and the picker', () => {
  it('treats a compatibility group as compatible and different dimensions as not', () => {
    const int4 = TYPE_CATALOG.resolve({ name: 'int4' }, ctx);
    const serial = TYPE_CATALOG.resolve({ name: 'serial' }, ctx);
    const varchar = TYPE_CATALOG.resolve({ name: 'varchar' }, ctx);
    const int4Array = TYPE_CATALOG.resolve({ name: 'int4', dimensions: 1 }, ctx);
    expect(TYPE_CATALOG.areCompatible(int4, serial)).toBe(true);
    expect(TYPE_CATALOG.areCompatible(int4, varchar)).toBe(false);
    expect(TYPE_CATALOG.areCompatible(int4, int4Array)).toBe(false);
  });

  it('folds user-defined types into the same picker, grouped and filtered by kind', () => {
    const options = TYPE_CATALOG.listPickerOptions(ctx);
    const varchar = options.find((o) => o.value.name === 'varchar');
    const enumOption = options.find((o) => o.customTypeId === 'ct1');
    expect(varchar?.group).toBe('Text');
    expect(enumOption?.group).toBe('Enums');
    expect(enumOption?.label).toBe('order_status');
    // 'composite' is not in userTypeGroups, i.e. usableAsFieldType: false.
    expect(options.some((o) => o.customTypeId === 'ct3')).toBe(false);
  });
});
