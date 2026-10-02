import {
  createTypeCatalog,
  type TypeCatalog,
  type TypeCategory,
  type TypeDescriptor,
  type TypeParameterDescriptor,
} from '@schemaloom/engine-sdk';

/**
 * The MySQL and MariaDB built-in types. `id` is the canonical lower-case spelling the exporter
 * writes; the other spellings the parser or `SHOW CREATE TABLE` may produce are aliases.
 *
 * `ENUM('a','b')` and `SET('a','b')` are ordinary types whose allowed values are the
 * `TypeRef.args` (strings), not custom types (design §3). `UNSIGNED` and `ZEROFILL` are field
 * props, not part of the type.
 */

interface TypeSpec {
  readonly id: string;
  readonly category: TypeCategory;
  readonly summary: string;
  readonly displayName?: string;
  readonly aliases?: readonly string[];
  readonly parameters?: readonly TypeParameterDescriptor[];
  readonly preferred?: boolean;
  readonly deprecated?: boolean;
}

function describe(spec: TypeSpec): TypeDescriptor {
  return {
    id: spec.id,
    displayName: spec.displayName ?? spec.id,
    category: spec.category,
    aliases: spec.aliases ?? [],
    parameters: spec.parameters ?? [],
    supportsArray: false,
    preferredForCategory: spec.preferred ?? false,
    deprecated: spec.deprecated ?? false,
    summary: spec.summary,
  };
}

const number = (
  name: string,
  label: string,
  min: number,
  max: number,
): TypeParameterDescriptor => ({
  kind: 'number',
  name,
  label,
  required: false,
  min,
  max,
  default: null,
});

const length = (max: number): TypeParameterDescriptor => number('length', 'Length', 1, max);
const fsp = number('precision', 'Fractional seconds', 0, 6);

const SPECS: readonly TypeSpec[] = [
  // --- numeric ---
  { id: 'tinyint', category: 'numeric', aliases: ['int1'], summary: '8-bit integer' },
  { id: 'smallint', category: 'numeric', aliases: ['int2'], summary: '16-bit integer' },
  {
    id: 'mediumint',
    category: 'numeric',
    aliases: ['int3', 'middleint'],
    summary: '24-bit integer',
  },
  {
    id: 'int',
    category: 'numeric',
    aliases: ['integer', 'int4'],
    preferred: true,
    summary: '32-bit integer',
  },
  { id: 'bigint', category: 'numeric', aliases: ['int8'], summary: '64-bit integer' },
  {
    id: 'decimal',
    category: 'numeric',
    displayName: 'decimal(p,s)',
    aliases: ['numeric', 'dec', 'fixed'],
    parameters: [number('precision', 'Precision', 1, 65), number('scale', 'Scale', 0, 30)],
    summary: 'Exact number with a chosen precision and scale',
  },
  { id: 'float', category: 'numeric', aliases: ['float4'], summary: '32-bit floating point' },
  {
    id: 'double',
    category: 'numeric',
    aliases: ['double precision', 'real', 'float8'],
    summary: '64-bit floating point',
  },
  {
    id: 'bit',
    category: 'numeric',
    parameters: [length(64)],
    summary: 'Bit field of 1 to 64 bits',
  },
  {
    id: 'boolean',
    category: 'boolean',
    aliases: ['bool'],
    preferred: true,
    summary: 'True or false (stored as tinyint(1))',
  },

  // --- string ---
  { id: 'char', category: 'string', parameters: [length(255)], summary: 'Fixed-length string' },
  {
    id: 'varchar',
    category: 'string',
    aliases: ['character varying', 'nvarchar'],
    parameters: [length(65_535)],
    preferred: true,
    summary: 'Variable-length string up to a maximum length',
  },
  { id: 'tinytext', category: 'string', summary: 'Text up to 255 bytes' },
  { id: 'text', category: 'string', summary: 'Text up to 64 KB' },
  { id: 'mediumtext', category: 'string', summary: 'Text up to 16 MB' },
  { id: 'longtext', category: 'string', summary: 'Text up to 4 GB' },
  { id: 'enum', category: 'string', summary: 'One value from a fixed list' },
  { id: 'set', category: 'string', summary: 'Any combination of values from a fixed list' },

  // --- binary ---
  { id: 'binary', category: 'binary', parameters: [length(255)], summary: 'Fixed-length bytes' },
  {
    id: 'varbinary',
    category: 'binary',
    parameters: [length(65_535)],
    summary: 'Variable-length bytes up to a maximum length',
  },
  { id: 'tinyblob', category: 'binary', summary: 'Bytes up to 255' },
  { id: 'blob', category: 'binary', preferred: true, summary: 'Bytes up to 64 KB' },
  { id: 'mediumblob', category: 'binary', summary: 'Bytes up to 16 MB' },
  { id: 'longblob', category: 'binary', summary: 'Bytes up to 4 GB' },

  // --- temporal ---
  { id: 'date', category: 'temporal', summary: 'Calendar date' },
  { id: 'time', category: 'temporal', parameters: [fsp], summary: 'Time of day or duration' },
  {
    id: 'datetime',
    category: 'temporal',
    parameters: [fsp],
    preferred: true,
    summary: 'Date and time, with no time zone',
  },
  {
    id: 'timestamp',
    category: 'temporal',
    parameters: [fsp],
    summary: 'Date and time stored as UTC, 1970 to 2038',
  },
  { id: 'year', category: 'temporal', summary: 'A year, 1901 to 2155' },

  // --- json, uuid, network (the last two are MariaDB only) ---
  { id: 'json', category: 'json', preferred: true, summary: 'JSON document' },
  { id: 'uuid', category: 'uuid', summary: 'UUID (MariaDB 10.7 and later)' },
  { id: 'inet4', category: 'network', summary: 'IPv4 address (MariaDB 10.10 and later)' },
  { id: 'inet6', category: 'network', summary: 'IPv6 address (MariaDB 10.5 and later)' },

  // --- spatial ---
  { id: 'geometry', category: 'geometric', preferred: true, summary: 'Any spatial value' },
  { id: 'point', category: 'geometric', summary: 'A point' },
  { id: 'linestring', category: 'geometric', summary: 'A line' },
  { id: 'polygon', category: 'geometric', summary: 'A polygon' },
  { id: 'multipoint', category: 'geometric', summary: 'A set of points' },
  { id: 'multilinestring', category: 'geometric', summary: 'A set of lines' },
  { id: 'multipolygon', category: 'geometric', summary: 'A set of polygons' },
  {
    id: 'geometrycollection',
    category: 'geometric',
    aliases: ['geomcollection'],
    summary: 'A collection of spatial values',
  },
];

export const TYPE_DESCRIPTORS: readonly TypeDescriptor[] = SPECS.map(describe);

/** The integer types: `AUTO_INCREMENT` and `UNSIGNED` apply to these. */
export const INTEGER_TYPE_IDS: ReadonlySet<string> = new Set([
  'tinyint',
  'smallint',
  'mediumint',
  'int',
  'bigint',
]);

/** Types an index can only use with a prefix length (`col(20)`). */
export const PREFIX_ONLY_TYPE_IDS: ReadonlySet<string> = new Set([
  'tinytext',
  'text',
  'mediumtext',
  'longtext',
  'tinyblob',
  'blob',
  'mediumblob',
  'longblob',
]);

/**
 * MySQL's foreign keys are strict: integer columns must have the same size and signedness, so
 * there is no integer family here. Character columns may differ in length.
 */
const COMPATIBILITY_GROUPS: readonly (readonly string[])[] = [['char', 'varchar']];

export const TYPE_CATALOG: TypeCatalog = createTypeCatalog({
  descriptors: TYPE_DESCRIPTORS,
  arraySyntax: 'none',
  compatibilityGroups: COMPATIBILITY_GROUPS,
  userTypeGroups: {},
});
