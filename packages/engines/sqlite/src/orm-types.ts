import type { TypeRef } from '@schemaloom/engine-sdk';
import type { OrmDialect, OrmTypeEntry } from '@schemaloom/orm';
import { CODE } from './messages.js';
import { TYPE_CATALOG } from './types.js';

/**
 * Phase 8 / 13 — SQLite's half of the ORM exports and of Prisma import. SQLite has no enums
 * and Prisma has no `@db.*` types for it, so this is mostly the scalar each declared name
 * maps to.
 */

const LENGTH = ['length'];

const integer = (
  ts: 'number' | 'string',
  prisma: 'Int' | 'BigInt',
  django: string,
): OrmTypeEntry => ({
  prisma: { scalar: prisma },
  drizzle: { fn: 'integer', options: "mode: 'number'" },
  typeorm: { type: 'integer' },
  django: { field: django },
  ts,
});

const textual = (typeorm: string, length: boolean): OrmTypeEntry => ({
  prisma: { scalar: 'String' },
  drizzle: length ? { fn: 'text', params: LENGTH } : { fn: 'text' },
  typeorm: length ? { type: typeorm, params: LENGTH } : { type: typeorm },
  django: length ? { field: 'CharField', params: ['max_length'] } : { field: 'TextField' },
  ts: 'string',
});

const TYPES: Readonly<Record<string, OrmTypeEntry>> = {
  integer: integer('number', 'Int', 'IntegerField'),
  bigint: integer('string', 'BigInt', 'BigIntegerField'),
  smallint: integer('number', 'Int', 'SmallIntegerField'),
  tinyint: integer('number', 'Int', 'SmallIntegerField'),
  real: {
    prisma: { scalar: 'Float' },
    drizzle: { fn: 'real' },
    typeorm: { type: 'real' },
    django: { field: 'FloatField' },
    ts: 'number',
  },
  double: {
    prisma: { scalar: 'Float' },
    drizzle: { fn: 'real' },
    typeorm: { type: 'double' },
    django: { field: 'FloatField' },
    ts: 'number',
  },
  float: {
    prisma: { scalar: 'Float' },
    drizzle: { fn: 'real' },
    typeorm: { type: 'float' },
    django: { field: 'FloatField' },
    ts: 'number',
  },
  numeric: {
    prisma: { scalar: 'Decimal' },
    drizzle: { fn: 'numeric' },
    typeorm: { type: 'numeric' },
    django: { field: 'DecimalField' },
    ts: 'string',
  },
  decimal: {
    prisma: { scalar: 'Decimal' },
    drizzle: { fn: 'numeric' },
    typeorm: { type: 'decimal', params: ['precision', 'scale'] },
    django: { field: 'DecimalField', params: ['max_digits', 'decimal_places'] },
    ts: 'string',
  },
  boolean: {
    prisma: { scalar: 'Boolean' },
    drizzle: { fn: 'integer', options: "mode: 'boolean'" },
    typeorm: { type: 'boolean' },
    django: { field: 'BooleanField' },
    ts: 'boolean',
  },
  text: textual('text', false),
  varchar: textual('varchar', true),
  char: textual('character', true),
  clob: textual('clob', false),
  blob: {
    prisma: { scalar: 'Bytes' },
    drizzle: { fn: 'blob', options: "mode: 'buffer'" },
    typeorm: { type: 'blob' },
    django: { field: 'BinaryField' },
    ts: 'Buffer',
  },
  date: {
    prisma: { scalar: 'DateTime' },
    drizzle: { fn: 'text' },
    typeorm: { type: 'date' },
    django: { field: 'DateField' },
    ts: 'string',
  },
  datetime: {
    prisma: { scalar: 'DateTime' },
    drizzle: { fn: 'text' },
    typeorm: { type: 'datetime' },
    django: { field: 'DateTimeField' },
    ts: 'Date',
  },
  timestamp: {
    prisma: { scalar: 'DateTime' },
    drizzle: { fn: 'text' },
    typeorm: { type: 'datetime' },
    django: { field: 'DateTimeField' },
    ts: 'Date',
  },
  time: {
    prisma: { scalar: 'String' },
    drizzle: { fn: 'text' },
    typeorm: { type: 'time' },
    django: { field: 'TimeField' },
    ts: 'string',
  },
  json: {
    prisma: { scalar: 'Json' },
    drizzle: { fn: 'text', options: "mode: 'json'" },
    typeorm: { type: 'simple-json' },
    django: { field: 'JSONField' },
    ts: 'unknown',
  },
};

const BUILTIN = { customTypes: [], namespaceName: null };
const buildType = (name: string, args?: readonly (string | number)[]): TypeRef =>
  TYPE_CATALOG.buildRef({ name, ...(args === undefined ? {} : { args }) }, BUILTIN);

export const ORM_DIALECT: OrmDialect = {
  prismaImport: {
    engineId: 'sqlite',
    importFailedCode: CODE.importStatementFailed,
    defaultNamespace: '',
    // What `prisma migrate` creates on SQLite for each scalar.
    defaults: {
      String: { id: 'text' },
      Int: { id: 'integer' },
      BigInt: { id: 'bigint' },
      Float: { id: 'real' },
      Decimal: { id: 'decimal' },
      DateTime: { id: 'datetime' },
      Boolean: { id: 'boolean' },
      Json: { id: 'json' },
      Bytes: { id: 'blob' },
    },
    enums: 'check',
    implicitManyToManyKey: 'unique',
    type: (id, args) => ({ type: buildType(id, args), props: {} }),
    parseType(text) {
      const parsed = /^\s*([^()]+?)\s*(?:\(([^)]*)\))?\s*$/.exec(text);
      if (parsed?.[1] === undefined) return null;
      const args = parsed[2]?.split(',').map((a) => (/^\s*\d+\s*$/.test(a) ? Number(a) : a.trim()));
      return buildType(parsed[1].toLowerCase(), args);
    },
    autoIncrement: (type, props) => ({ type, props: { ...props, autoIncrement: true } }),
    plainType: (type) => type,
    plainColumnProps: () => ({}),
    primaryKeyName: (table) => `${table}_pkey`,
    indexKind: () => 'btree',
    quote: (name) => `"${name.replace(/"/g, '""')}"`,
  },
  prismaProvider: 'sqlite',
  drizzle: { core: 'sqlite-core', prefix: 'sqlite' },
  namedEnums: false,
  omittedCode: CODE.exportOmitted,
  namedPrimaryKeys: false,
  types: TYPES,
  columnType(field) {
    const resolved = TYPE_CATALOG.resolve(field.type, BUILTIN);
    return {
      id: resolved.descriptor?.id ?? null,
      args: resolved.ref.args ?? null,
      dimensions: 0,
      display: TYPE_CATALOG.format(resolved),
      enumKey: null,
    };
  },
  enums: () => ({ enums: [], hidden: [] }),
  autoIncrement: (field) =>
    field.propsRedacted !== true && field.engineProps.autoIncrement === true,
  indexMethod: () => null,
};
