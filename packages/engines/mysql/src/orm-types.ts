import type { Field, Id, TypeRef } from '@schemaloom/engine-sdk';
import { compare, type OrmDialect, type OrmEnum, type OrmTypeEntry } from '@schemaloom/orm';
import { renderType } from './exporter.js';
import { CODE } from './messages.js';
import { TYPE_CATALOG } from './types.js';

/**
 * Phase 8 — MySQL/MariaDB's half of the ORM exports (`docs/phase8/DESIGN.md` §2.2). An
 * `UNSIGNED` integer is its own row (`int unsigned`), because every ORM spells it apart.
 * `enum(…)` belongs to its column, so each one is an enum named `<table>_<column>`, as
 * `prisma db pull` names it.
 */

const LENGTH = ['length'];

/** An integer type and its `UNSIGNED` twin. */
function integer(
  id: string,
  prisma: { scalar: string; native?: string; unsigned: string },
  django: { field: string; unsigned: string },
  ts: 'number' | 'string',
): [string, OrmTypeEntry][] {
  const drizzle = id === 'bigint' ? "mode: 'number'" : undefined;
  const both = (unsigned: boolean): OrmTypeEntry => ({
    prisma: {
      scalar: prisma.scalar,
      ...(unsigned
        ? { native: prisma.unsigned }
        : prisma.native === undefined
          ? {}
          : { native: prisma.native }),
    },
    drizzle: {
      fn: id,
      ...(unsigned || drizzle !== undefined
        ? { options: [drizzle, unsigned ? 'unsigned: true' : undefined].filter(Boolean).join(', ') }
        : {}),
    },
    typeorm: { type: id, ...(unsigned ? { options: 'unsigned: true' } : {}) },
    django: { field: unsigned ? django.unsigned : django.field },
    ts,
  });
  return [
    [id, both(false)],
    [`${id} unsigned`, both(true)],
  ];
}

/**
 * One row per canonical type; an ORM missing from a row can't spell the type, and its writer
 * falls back. `prisma.precision` is MySQL's default when none is written.
 */
const TYPES: Readonly<Record<string, OrmTypeEntry>> = {
  ...Object.fromEntries([
    ...integer(
      'tinyint',
      { scalar: 'Int', native: 'TinyInt', unsigned: 'UnsignedTinyInt' },
      { field: 'IntegerField', unsigned: 'PositiveSmallIntegerField' },
      'number',
    ),
    ...integer(
      'smallint',
      { scalar: 'Int', native: 'SmallInt', unsigned: 'UnsignedSmallInt' },
      { field: 'SmallIntegerField', unsigned: 'PositiveSmallIntegerField' },
      'number',
    ),
    ...integer(
      'mediumint',
      { scalar: 'Int', native: 'MediumInt', unsigned: 'UnsignedMediumInt' },
      { field: 'IntegerField', unsigned: 'PositiveIntegerField' },
      'number',
    ),
    ...integer(
      'int',
      { scalar: 'Int', unsigned: 'UnsignedInt' },
      { field: 'IntegerField', unsigned: 'PositiveIntegerField' },
      'number',
    ),
    ...integer(
      'bigint',
      { scalar: 'BigInt', unsigned: 'UnsignedBigInt' },
      { field: 'BigIntegerField', unsigned: 'PositiveBigIntegerField' },
      'string',
    ),
  ]),
  decimal: {
    prisma: { scalar: 'Decimal', native: 'Decimal' },
    drizzle: { fn: 'decimal', params: ['precision', 'scale'] },
    typeorm: { type: 'decimal', params: ['precision', 'scale'] },
    django: { field: 'DecimalField', params: ['max_digits', 'decimal_places'] },
    ts: 'string',
  },
  float: {
    prisma: { scalar: 'Float', native: 'Float' },
    drizzle: { fn: 'float' },
    typeorm: { type: 'float' },
    django: { field: 'FloatField' },
    ts: 'number',
  },
  double: {
    prisma: { scalar: 'Float' },
    drizzle: { fn: 'double' },
    typeorm: { type: 'double' },
    django: { field: 'FloatField' },
    ts: 'number',
  },
  bit: { prisma: { scalar: 'Bytes', native: 'Bit' }, typeorm: { type: 'bit' }, ts: 'Buffer' },
  boolean: {
    prisma: { scalar: 'Boolean' },
    drizzle: { fn: 'boolean' },
    typeorm: { type: 'boolean' },
    django: { field: 'BooleanField' },
    ts: 'boolean',
  },
  char: {
    prisma: { scalar: 'String', native: 'Char' },
    drizzle: { fn: 'char', params: LENGTH },
    typeorm: { type: 'char', params: LENGTH },
    django: { field: 'CharField', params: ['max_length'] },
    ts: 'string',
  },
  varchar: {
    prisma: { scalar: 'String', native: 'VarChar' },
    drizzle: { fn: 'varchar', params: LENGTH },
    typeorm: { type: 'varchar', params: LENGTH },
    django: { field: 'CharField', params: ['max_length'] },
    ts: 'string',
  },
  ...Object.fromEntries(
    (
      [
        ['tinytext', 'TinyText'],
        ['text', 'Text'],
        ['mediumtext', 'MediumText'],
        ['longtext', 'LongText'],
      ] as const
    ).map(([id, native]): [string, OrmTypeEntry] => [
      id,
      {
        prisma: { scalar: 'String', native },
        drizzle: { fn: id },
        typeorm: { type: id },
        django: { field: 'TextField' },
        ts: 'string',
      },
    ]),
  ),
  binary: {
    prisma: { scalar: 'Bytes', native: 'Binary' },
    drizzle: { fn: 'binary', params: LENGTH },
    typeorm: { type: 'binary', params: LENGTH },
    django: { field: 'BinaryField' },
    ts: 'Buffer',
  },
  varbinary: {
    prisma: { scalar: 'Bytes', native: 'VarBinary' },
    drizzle: { fn: 'varbinary', params: LENGTH },
    typeorm: { type: 'varbinary', params: LENGTH },
    django: { field: 'BinaryField' },
    ts: 'Buffer',
  },
  ...Object.fromEntries(
    (
      [
        ['tinyblob', 'TinyBlob'],
        ['blob', 'Blob'],
        ['mediumblob', 'MediumBlob'],
        ['longblob', undefined],
      ] as const
    ).map(([id, native]): [string, OrmTypeEntry] => [
      id,
      {
        prisma: native === undefined ? { scalar: 'Bytes' } : { scalar: 'Bytes', native },
        typeorm: { type: id },
        django: { field: 'BinaryField' },
        ts: 'Buffer',
      },
    ]),
  ),
  date: {
    prisma: { scalar: 'DateTime', native: 'Date' },
    drizzle: { fn: 'date' },
    typeorm: { type: 'date' },
    django: { field: 'DateField' },
    ts: 'string',
  },
  time: {
    prisma: { scalar: 'DateTime', native: 'Time', precision: 0 },
    drizzle: { fn: 'time', params: ['fsp'] },
    typeorm: { type: 'time', params: ['precision'] },
    django: { field: 'TimeField' },
    ts: 'string',
  },
  datetime: {
    prisma: { scalar: 'DateTime', native: 'DateTime', precision: 0 },
    drizzle: { fn: 'datetime', params: ['fsp'] },
    typeorm: { type: 'datetime', params: ['precision'] },
    django: { field: 'DateTimeField' },
    ts: 'Date',
  },
  timestamp: {
    prisma: { scalar: 'DateTime', native: 'Timestamp', precision: 0 },
    drizzle: { fn: 'timestamp', params: ['fsp'] },
    typeorm: { type: 'timestamp', params: ['precision'] },
    django: { field: 'DateTimeField' },
    ts: 'Date',
  },
  year: {
    prisma: { scalar: 'Int', native: 'Year' },
    drizzle: { fn: 'year' },
    typeorm: { type: 'year' },
    django: { field: 'SmallIntegerField' },
    ts: 'number',
  },
  json: {
    prisma: { scalar: 'Json' },
    drizzle: { fn: 'json' },
    typeorm: { type: 'json' },
    django: { field: 'JSONField' },
    ts: 'unknown',
  },
  uuid: { typeorm: { type: 'uuid' }, django: { field: 'UUIDField' }, ts: 'string' },
  ...Object.fromEntries(
    [
      'geometry',
      'point',
      'linestring',
      'polygon',
      'multipoint',
      'multilinestring',
      'multipolygon',
      'geometrycollection',
    ].map((id): [string, OrmTypeEntry] => [id, { typeorm: { type: id }, ts: 'unknown' }]),
  ),
};

const INTEGERS = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint']);

const isEnum = (field: Field): boolean => field.type.name.toLowerCase() === 'enum';

const BUILTIN = { customTypes: [], namespaceName: null };
const buildType = (name: string, args?: readonly (string | number)[]): TypeRef =>
  TYPE_CATALOG.buildRef({ name, ...(args === undefined ? {} : { args }) }, BUILTIN);

export const ORM_DIALECT: OrmDialect = {
  prismaImport: {
    engineId: 'mysql',
    importFailedCode: CODE.importStatementFailed,
    defaultNamespace: '',
    // What `prisma migrate` creates for a scalar written without `@db.*`.
    defaults: {
      String: { id: 'varchar', args: [191] },
      Int: { id: 'int' },
      BigInt: { id: 'bigint' },
      Float: { id: 'double' },
      Decimal: { id: 'decimal', args: [65, 30] },
      DateTime: { id: 'datetime', args: [3] },
      Boolean: { id: 'boolean' },
      Json: { id: 'json' },
      Bytes: { id: 'longblob' },
    },
    enums: 'inline',
    implicitManyToManyKey: 'unique',
    type(id, args) {
      const unsigned = id.endsWith(' unsigned');
      return {
        type: buildType(unsigned ? id.slice(0, -' unsigned'.length) : id, args),
        props: unsigned ? { unsigned: true } : {},
      };
    },
    parseType(text) {
      const parsed = /^\s*([^()]+?)\s*(?:\(([^)]*)\))?\s*$/.exec(text);
      if (parsed?.[1] === undefined) return null;
      const args = parsed[2]
        ?.split(',')
        .map((a) => (/^\s*\d+\s*$/.test(a) ? Number(a) : a.trim().replace(/^'|'$/g, '')));
      return buildType(parsed[1], args);
    },
    autoIncrement: (type, props) => ({ type, props: { ...props, autoIncrement: true } }),
    plainType: (type) => type,
    plainColumnProps: (props) => (props.unsigned === true ? { unsigned: true } : {}),
    primaryKeyName: () => 'PRIMARY',
    indexKind: (algorithm) => (algorithm === 'fulltext' ? 'fulltext' : 'btree'),
    quote: (name) => `\`${name.replace(/`/g, '``')}\``,
  },
  prismaProvider: 'mysql',
  drizzle: { core: 'mysql-core', prefix: 'mysql' },
  namedEnums: false,
  omittedCode: CODE.exportOmitted,
  namedPrimaryKeys: false,
  types: TYPES,
  columnType(field) {
    const resolved = TYPE_CATALOG.resolve(field.type, { customTypes: [], namespaceName: null });
    const base = resolved.descriptor?.id ?? null;
    const unsigned = field.propsRedacted !== true && field.engineProps.unsigned === true;
    return {
      id: base !== null && unsigned && INTEGERS.has(base) ? `${base} unsigned` : base,
      args: isEnum(field) ? null : (resolved.ref.args ?? null),
      dimensions: 0,
      display: renderType(field),
      enumKey: isEnum(field) ? field.id : null,
    };
  },
  enums(model) {
    const enums: OrmEnum[] = [];
    for (const field of Object.values(model.objects.field)) {
      const entity = model.objects.entity[field.entityId];
      if (!isEnum(field) || field.restricted === true || entity === undefined) continue;
      if (entity.restricted === true || entity.kind !== 'table') continue;
      enums.push({
        key: field.id,
        name: `${entity.name}_${field.name}`,
        namespaceId: null,
        labels: (field.type.args ?? []).map(String),
        target: { type: 'field', id: field.id },
      });
    }
    enums.sort((a, b) => compare(a.name, b.name) || compare(a.key, b.key));
    return { enums, hidden: [] as Id[] };
  },
  autoIncrement: (field) =>
    field.propsRedacted !== true && field.engineProps.autoIncrement === true,
  // InnoDB builds a HASH index as a b-tree, so only FULLTEXT and SPATIAL are their own kind.
  indexMethod: (index) =>
    index.kind === 'fulltext' || index.kind === 'spatial' ? index.kind : null,
};
