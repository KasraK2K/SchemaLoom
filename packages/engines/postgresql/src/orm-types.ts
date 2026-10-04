import type { Field, Id, SchemaModel, TypeRef } from '@schemaloom/engine-sdk';
import type { OrmDialect, OrmEnum, OrmTypeEntry } from '@schemaloom/orm';
import { propString, propStringArray } from './export-ddl.js';
import { compare } from './exporter.js';
import { CODE } from './messages.js';
import { TYPE_CATALOG } from './types.js';

/**
 * Phase 8 — PostgreSQL's half of the ORM exports (`docs/phase8/DESIGN.md` §2.2): how each
 * canonical type is spelled per ORM, and the PostgreSQL facts the writers can't read off the
 * IR (domains, enums as custom types, serial and identity, index methods).
 */

const LENGTH = ['length'];
const PRECISION = ['precision'];

/**
 * One row per canonical type; an ORM missing from a row can't spell the type, and its writer
 * falls back (Prisma `Unsupported`, Drizzle `customType`, a cast for TypeORM, a guessed
 * `TextField` for Django). `prisma.precision` is PostgreSQL's default when none is written.
 */
const TYPES: Readonly<Record<string, OrmTypeEntry>> = {
  smallint: {
    prisma: { scalar: 'Int', native: 'SmallInt' },
    drizzle: { fn: 'smallint' },
    typeorm: { type: 'smallint' },
    django: { field: 'SmallIntegerField' },
    ts: 'number',
  },
  integer: {
    prisma: { scalar: 'Int' },
    drizzle: { fn: 'integer' },
    typeorm: { type: 'integer' },
    django: { field: 'IntegerField' },
    ts: 'number',
  },
  bigint: {
    prisma: { scalar: 'BigInt' },
    drizzle: { fn: 'bigint', options: "mode: 'number'" },
    typeorm: { type: 'bigint' },
    django: { field: 'BigIntegerField' },
    ts: 'string',
  },
  smallserial: {
    prisma: { scalar: 'Int', native: 'SmallInt' },
    drizzle: { fn: 'smallserial' },
    typeorm: { type: 'smallint' },
    django: { field: 'SmallIntegerField' },
    ts: 'number',
  },
  serial: {
    prisma: { scalar: 'Int' },
    drizzle: { fn: 'serial' },
    typeorm: { type: 'integer' },
    django: { field: 'IntegerField' },
    ts: 'number',
  },
  bigserial: {
    prisma: { scalar: 'BigInt' },
    drizzle: { fn: 'bigserial', options: "mode: 'number'" },
    typeorm: { type: 'bigint' },
    django: { field: 'BigIntegerField' },
    ts: 'string',
  },
  numeric: {
    prisma: { scalar: 'Decimal', native: 'Decimal' },
    drizzle: { fn: 'numeric', params: ['precision', 'scale'] },
    typeorm: { type: 'numeric', params: ['precision', 'scale'] },
    django: { field: 'DecimalField', params: ['max_digits', 'decimal_places'] },
    ts: 'string',
  },
  real: {
    prisma: { scalar: 'Float', native: 'Real' },
    drizzle: { fn: 'real' },
    typeorm: { type: 'real' },
    django: { field: 'FloatField' },
    ts: 'number',
  },
  'double precision': {
    prisma: { scalar: 'Float' },
    drizzle: { fn: 'doublePrecision' },
    typeorm: { type: 'double precision' },
    django: { field: 'FloatField' },
    ts: 'number',
  },
  money: {
    prisma: { scalar: 'Decimal', native: 'Money' },
    typeorm: { type: 'money' },
    ts: 'string',
  },
  text: {
    prisma: { scalar: 'String' },
    drizzle: { fn: 'text' },
    typeorm: { type: 'text' },
    django: { field: 'TextField' },
    ts: 'string',
  },
  varchar: {
    prisma: { scalar: 'String', native: 'VarChar' },
    drizzle: { fn: 'varchar', params: LENGTH },
    typeorm: { type: 'varchar', params: LENGTH },
    django: { field: 'CharField', params: ['max_length'] },
    ts: 'string',
  },
  char: {
    prisma: { scalar: 'String', native: 'Char' },
    drizzle: { fn: 'char', params: LENGTH },
    typeorm: { type: 'char', params: LENGTH },
    django: { field: 'CharField', params: ['max_length'] },
    ts: 'string',
  },
  boolean: {
    prisma: { scalar: 'Boolean' },
    drizzle: { fn: 'boolean' },
    typeorm: { type: 'boolean' },
    django: { field: 'BooleanField' },
    ts: 'boolean',
  },
  date: {
    prisma: { scalar: 'DateTime', native: 'Date' },
    drizzle: { fn: 'date' },
    typeorm: { type: 'date' },
    django: { field: 'DateField' },
    ts: 'string',
  },
  time: {
    prisma: { scalar: 'DateTime', native: 'Time', precision: 6 },
    drizzle: { fn: 'time', params: PRECISION },
    typeorm: { type: 'time', params: PRECISION },
    django: { field: 'TimeField' },
    ts: 'string',
  },
  timetz: {
    prisma: { scalar: 'DateTime', native: 'Timetz', precision: 6 },
    drizzle: { fn: 'time', params: PRECISION, options: 'withTimezone: true' },
    typeorm: { type: 'time with time zone', params: PRECISION },
    django: { field: 'TimeField' },
    ts: 'string',
  },
  timestamp: {
    prisma: { scalar: 'DateTime', native: 'Timestamp', precision: 6 },
    drizzle: { fn: 'timestamp', params: PRECISION },
    typeorm: { type: 'timestamp', params: PRECISION },
    django: { field: 'DateTimeField' },
    ts: 'Date',
  },
  timestamptz: {
    prisma: { scalar: 'DateTime', native: 'Timestamptz', precision: 6 },
    drizzle: { fn: 'timestamp', params: PRECISION, options: 'withTimezone: true' },
    typeorm: { type: 'timestamp with time zone', params: PRECISION },
    django: { field: 'DateTimeField' },
    ts: 'Date',
  },
  interval: {
    drizzle: { fn: 'interval' },
    typeorm: { type: 'interval' },
    django: { field: 'DurationField' },
    ts: 'string',
  },
  uuid: {
    prisma: { scalar: 'String', native: 'Uuid' },
    drizzle: { fn: 'uuid' },
    typeorm: { type: 'uuid' },
    django: { field: 'UUIDField' },
    ts: 'string',
  },
  json: {
    prisma: { scalar: 'Json', native: 'Json' },
    drizzle: { fn: 'json' },
    typeorm: { type: 'json' },
    django: { field: 'JSONField' },
    ts: 'unknown',
  },
  jsonb: {
    prisma: { scalar: 'Json' },
    drizzle: { fn: 'jsonb' },
    typeorm: { type: 'jsonb' },
    django: { field: 'JSONField' },
    ts: 'unknown',
  },
  bytea: {
    prisma: { scalar: 'Bytes' },
    typeorm: { type: 'bytea' },
    django: { field: 'BinaryField' },
    ts: 'Buffer',
  },
  bit: {
    prisma: { scalar: 'String', native: 'Bit' },
    typeorm: { type: 'bit', params: LENGTH },
    ts: 'string',
  },
  varbit: {
    prisma: { scalar: 'String', native: 'VarBit' },
    typeorm: { type: 'varbit', params: LENGTH },
    ts: 'string',
  },
  inet: {
    prisma: { scalar: 'String', native: 'Inet' },
    drizzle: { fn: 'inet' },
    typeorm: { type: 'inet' },
    django: { field: 'GenericIPAddressField' },
    ts: 'string',
  },
  cidr: { drizzle: { fn: 'cidr' }, typeorm: { type: 'cidr' }, ts: 'string' },
  macaddr: { drizzle: { fn: 'macaddr' }, typeorm: { type: 'macaddr' }, ts: 'string' },
  macaddr8: { drizzle: { fn: 'macaddr8' }, ts: 'string' },
  point: { typeorm: { type: 'point' }, ts: 'unknown' },
  line: { typeorm: { type: 'line' }, ts: 'unknown' },
  lseg: { typeorm: { type: 'lseg' }, ts: 'unknown' },
  box: { typeorm: { type: 'box' }, ts: 'unknown' },
  path: { typeorm: { type: 'path' }, ts: 'unknown' },
  polygon: { typeorm: { type: 'polygon' }, ts: 'unknown' },
  circle: { typeorm: { type: 'circle' }, ts: 'unknown' },
  int4range: { typeorm: { type: 'int4range' }, ts: 'string' },
  int8range: { typeorm: { type: 'int8range' }, ts: 'string' },
  numrange: { typeorm: { type: 'numrange' }, ts: 'string' },
  tsrange: { typeorm: { type: 'tsrange' }, ts: 'string' },
  tstzrange: { typeorm: { type: 'tstzrange' }, ts: 'string' },
  daterange: { typeorm: { type: 'daterange' }, ts: 'string' },
  xml: { prisma: { scalar: 'String', native: 'Xml' }, typeorm: { type: 'xml' }, ts: 'string' },
  tsvector: { typeorm: { type: 'tsvector' }, ts: 'string' },
  tsquery: { typeorm: { type: 'tsquery' }, ts: 'string' },
};

const SERIAL = new Set(['smallserial', 'serial', 'bigserial']);

const context = (model: SchemaModel) => ({
  customTypes: Object.values(model.objects.customType),
  namespaceName: '',
});

/** The field's type resolved through domains to a built-in, with the domain's array-ness kept. */
function resolveField(field: Field, model: SchemaModel): ReturnType<typeof TYPE_CATALOG.resolve> {
  const ctx = context(model);
  let resolved = TYPE_CATALOG.resolve(field.type, ctx);
  const custom = resolved.customType;
  if (custom?.kind === 'domain' && custom.propsRedacted !== true) {
    const base = propString(custom.engineProps, 'baseType');
    const parsed = base === undefined ? null : /^\s*([^(]+?)\s*(?:\(([^)]*)\))?\s*$/.exec(base);
    if (parsed?.[1] !== undefined) {
      const args = parsed[2]?.split(',').map((a) => (/^\s*\d+\s*$/.test(a) ? Number(a) : a.trim()));
      const ref: TypeRef = {
        name: parsed[1],
        ...(args === undefined ? {} : { args }),
        dimensions: field.type.dimensions ?? 0,
      };
      resolved = TYPE_CATALOG.resolve(ref, ctx);
    }
  }
  return resolved;
}

export const ORM_DIALECT: OrmDialect = {
  prismaProvider: 'postgresql',
  drizzle: { core: 'pg-core', prefix: 'pg' },
  namedEnums: true,
  omittedCode: CODE.exportOmitted,
  namedPrimaryKeys: true,
  types: TYPES,
  columnType(field, model) {
    const resolved = resolveField(field, model);
    return {
      id: resolved.descriptor?.id ?? null,
      args: resolved.ref.args ?? null,
      dimensions: resolved.dimensions,
      display: TYPE_CATALOG.format(TYPE_CATALOG.resolve(field.type, context(model))),
      enumKey: resolved.customType?.id ?? null,
    };
  },
  enums(model) {
    const nsName = (id: Id): string => model.objects.namespace[id]?.name ?? '';
    const enums: OrmEnum[] = [];
    const hidden: Id[] = [];
    const sorted = Object.values(model.objects.customType).sort(
      (a, b) =>
        compare(nsName(a.namespaceId), nsName(b.namespaceId)) ||
        compare(a.name, b.name) ||
        compare(a.id, b.id),
    );
    for (const customType of sorted) {
      if (customType.restricted === true) {
        hidden.push(customType.id);
        continue;
      }
      // Domains map to their base type, composites to `Unsupported`.
      if (customType.kind !== 'enum') continue;
      const labels =
        customType.propsRedacted === true
          ? undefined
          : propStringArray(customType.engineProps, 'labels');
      if (labels === undefined || labels.length === 0) continue;
      enums.push({
        key: customType.id,
        name: customType.name,
        namespaceId: customType.namespaceId,
        labels,
        target: { type: 'customType', id: customType.id },
      });
    }
    return { enums, hidden };
  },
  autoIncrement(field) {
    const props = field.propsRedacted === true ? {} : field.engineProps;
    return (
      SERIAL.has(
        TYPE_CATALOG.resolve(field.type, { customTypes: [], namespaceName: '' }).descriptor?.id ??
          '',
      ) ||
      props.identity === 'always' ||
      props.identity === 'byDefault'
    );
  },
  indexMethod: (index) => (index.kind === 'btree' ? null : index.kind),
};
