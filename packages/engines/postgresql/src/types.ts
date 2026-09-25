import {
  createTypeCatalog,
  type TypeCatalog,
  type TypeCategory,
  type TypeDescriptor,
  type TypeParameterDescriptor,
} from '@schemaloom/engine-sdk';

/**
 * The PostgreSQL built-in type set (spec §3.4), plus the plumbing that folds user enums,
 * domains and composites into the same picker (doc 03 §5.4).
 *
 * `id` is BOTH the canonical spelling and what the exporter emits, so every id here is
 * valid DDL on its own. The internal `pg_catalog` names (`int4`, `bpchar`, `float8`) and
 * the SQL-standard long forms (`character varying`, `timestamp with time zone`) are
 * ALIASES: the importer hands `createTypeCatalog` whatever `libpg-query` normalised to,
 * and it resolves to the same descriptor either way.
 */

interface TypeSpec {
  readonly id: string;
  readonly category: TypeCategory;
  readonly summary: string;
  readonly displayName?: string;
  readonly aliases?: readonly string[];
  readonly parameters?: readonly TypeParameterDescriptor[];
  /** default true — nearly every PostgreSQL type has an array type */
  readonly supportsArray?: boolean;
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
    supportsArray: spec.supportsArray ?? true,
    preferredForCategory: spec.preferred ?? false,
    deprecated: spec.deprecated ?? false,
    summary: spec.summary,
  };
}

const lengthParam = (fallback: number | null): TypeParameterDescriptor => ({
  kind: 'number',
  name: 'length',
  label: 'Length',
  required: false,
  min: 1,
  max: 10_485_760,
  default: fallback,
});

const precisionParam: TypeParameterDescriptor = {
  kind: 'number',
  name: 'precision',
  label: 'Precision',
  required: false,
  min: 1,
  max: 1000,
  default: null,
};

const scaleParam: TypeParameterDescriptor = {
  kind: 'number',
  name: 'scale',
  label: 'Scale',
  required: false,
  min: 0,
  max: 1000,
  default: null,
};

/** `timestamp(3)` / `time(6)` — fractional-seconds precision, 0..6. */
const secondsPrecisionParam: TypeParameterDescriptor = {
  kind: 'number',
  name: 'precision',
  label: 'Fractional seconds',
  required: false,
  min: 0,
  max: 6,
  default: null,
};

const SPECS: readonly TypeSpec[] = [
  // --- numeric ---
  { id: 'smallint', category: 'numeric', aliases: ['int2'], summary: '16-bit signed integer' },
  {
    id: 'integer',
    category: 'numeric',
    aliases: ['int4', 'int'],
    preferred: true,
    summary: '32-bit signed integer',
  },
  { id: 'bigint', category: 'numeric', aliases: ['int8'], summary: '64-bit signed integer' },
  {
    id: 'numeric',
    category: 'numeric',
    displayName: 'numeric(p,s)',
    aliases: ['decimal'],
    parameters: [precisionParam, scaleParam],
    summary: 'Exact number with user-selected precision',
  },
  { id: 'real', category: 'numeric', aliases: ['float4'], summary: '32-bit floating point' },
  {
    id: 'double precision',
    category: 'numeric',
    aliases: ['float8'],
    summary: '64-bit floating point',
  },
  { id: 'money', category: 'numeric', summary: 'Currency amount, fixed fractional precision' },
  {
    id: 'smallserial',
    category: 'numeric',
    aliases: ['serial2'],
    supportsArray: false,
    deprecated: true,
    summary: 'Auto-incrementing smallint — prefer an identity column',
  },
  {
    id: 'serial',
    category: 'numeric',
    aliases: ['serial4'],
    supportsArray: false,
    deprecated: true,
    summary: 'Auto-incrementing integer — prefer an identity column',
  },
  {
    id: 'bigserial',
    category: 'numeric',
    aliases: ['serial8'],
    supportsArray: false,
    deprecated: true,
    summary: 'Auto-incrementing bigint — prefer an identity column',
  },

  // --- string ---
  { id: 'text', category: 'string', preferred: true, summary: 'Variable-length text, no limit' },
  {
    id: 'varchar',
    category: 'string',
    displayName: 'varchar(n)',
    aliases: ['character varying'],
    parameters: [lengthParam(255)],
    summary: 'Variable-length text with a length limit',
  },
  {
    id: 'char',
    category: 'string',
    displayName: 'char(n)',
    aliases: ['character', 'bpchar'],
    parameters: [lengthParam(1)],
    summary: 'Blank-padded fixed-length text',
  },

  // --- boolean ---
  {
    id: 'boolean',
    category: 'boolean',
    aliases: ['bool'],
    preferred: true,
    summary: 'true / false / null',
  },

  // --- temporal ---
  { id: 'date', category: 'temporal', summary: 'Calendar date, no time of day' },
  {
    id: 'time',
    category: 'temporal',
    aliases: ['time without time zone'],
    parameters: [secondsPrecisionParam],
    summary: 'Time of day, no time zone',
  },
  {
    id: 'timetz',
    category: 'temporal',
    aliases: ['time with time zone'],
    parameters: [secondsPrecisionParam],
    summary: 'Time of day with a time-zone offset',
  },
  {
    id: 'timestamp',
    category: 'temporal',
    aliases: ['timestamp without time zone'],
    parameters: [secondsPrecisionParam],
    summary: 'Date and time, no time zone',
  },
  {
    id: 'timestamptz',
    category: 'temporal',
    aliases: ['timestamp with time zone'],
    parameters: [secondsPrecisionParam],
    preferred: true,
    summary: 'Date and time, stored as UTC',
  },
  {
    id: 'interval',
    category: 'temporal',
    parameters: [secondsPrecisionParam],
    summary: 'A span of time',
  },

  // --- uuid ---
  { id: 'uuid', category: 'uuid', preferred: true, summary: '128-bit universally unique id' },

  // --- json ---
  { id: 'json', category: 'json', summary: 'JSON stored as text, preserving key order' },
  {
    id: 'jsonb',
    category: 'json',
    preferred: true,
    summary: 'JSON stored decomposed — indexable, deduplicated keys',
  },

  // --- binary ---
  { id: 'bytea', category: 'binary', preferred: true, summary: 'Binary string' },
  {
    id: 'bit',
    category: 'binary',
    displayName: 'bit(n)',
    parameters: [lengthParam(1)],
    summary: 'Fixed-length bit string',
  },
  {
    id: 'varbit',
    category: 'binary',
    displayName: 'varbit(n)',
    aliases: ['bit varying'],
    parameters: [lengthParam(null)],
    summary: 'Variable-length bit string',
  },

  // --- network ---
  { id: 'inet', category: 'network', preferred: true, summary: 'IPv4 or IPv6 host address' },
  { id: 'cidr', category: 'network', summary: 'IPv4 or IPv6 network address' },
  { id: 'macaddr', category: 'network', summary: '6-byte MAC address' },
  { id: 'macaddr8', category: 'network', summary: '8-byte (EUI-64) MAC address' },

  // --- geometric ---
  { id: 'point', category: 'geometric', preferred: true, summary: 'Point on a plane' },
  { id: 'line', category: 'geometric', summary: 'Infinite line' },
  { id: 'lseg', category: 'geometric', summary: 'Line segment' },
  { id: 'box', category: 'geometric', summary: 'Rectangular box' },
  { id: 'path', category: 'geometric', summary: 'Open or closed path' },
  { id: 'polygon', category: 'geometric', summary: 'Closed polygon' },
  { id: 'circle', category: 'geometric', summary: 'Circle' },

  // --- range ---
  { id: 'int4range', category: 'range', preferred: true, summary: 'Range of integer' },
  { id: 'int8range', category: 'range', summary: 'Range of bigint' },
  { id: 'numrange', category: 'range', summary: 'Range of numeric' },
  { id: 'tsrange', category: 'range', summary: 'Range of timestamp' },
  { id: 'tstzrange', category: 'range', summary: 'Range of timestamptz' },
  { id: 'daterange', category: 'range', summary: 'Range of date' },

  // --- other ---
  { id: 'xml', category: 'other', summary: 'XML document or fragment' },
  { id: 'tsvector', category: 'other', preferred: true, summary: 'Document for full-text search' },
  { id: 'tsquery', category: 'other', summary: 'Full-text search query' },
  { id: 'pg_lsn', category: 'other', summary: 'Write-ahead log sequence number' },
];

export const TYPE_DESCRIPTORS: readonly TypeDescriptor[] = SPECS.map(describe);

/** The integer types an identity column may use (validator rule `identity-non-integer`). */
export const IDENTITY_TYPE_IDS: ReadonlySet<string> = new Set([
  'smallint',
  'integer',
  'bigint',
]);

/**
 * Beyond exact equality. PostgreSQL will create a foreign key between any two types that
 * share an equality operator, which in practice means "within the integer family" and
 * "within the text family" — `serial` is `integer` plus a default, so an FK onto a
 * `serial` primary key from an `integer` column is the single most common shape there is.
 */
const COMPATIBILITY_GROUPS: readonly (readonly string[])[] = [
  ['smallint', 'integer', 'bigint', 'smallserial', 'serial', 'bigserial'],
  ['text', 'varchar', 'char'],
];

export const TYPE_CATALOG: TypeCatalog = createTypeCatalog({
  descriptors: TYPE_DESCRIPTORS,
  arraySyntax: 'suffix-brackets',
  compatibilityGroups: COMPATIBILITY_GROUPS,
  // No `normalizeAliases`: every alternate spelling is a real alias of a real descriptor,
  // and collapsing `serial` into `integer` would erase the declaration the exporter has to
  // emit. Link compatibility is the only place they are the same thing, and that is what
  // `compatibilityGroups` is for.
  userTypeGroups: { enum: 'Enums', domain: 'Domains', composite: 'Composite types' },
});
