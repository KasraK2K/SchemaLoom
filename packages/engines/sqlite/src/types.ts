import {
  createTypeCatalog,
  type TypeCatalog,
  type TypeCategory,
  type TypeDescriptor,
  type TypeParameterDescriptor,
} from '@schemaloom/engine-sdk';

/**
 * Phase 13 §3 — SQLite accepts any declared type name and stores it as written; what matters
 * to SQLite is the name's AFFINITY (`affinityOf`). The catalog lists the names people use, so
 * the type picker and the ORM tables know them; any other name resolves as `unknown` and
 * survives a round trip unchanged (Q3). A STRICT table allows only the five strict types.
 */

interface TypeSpec {
  readonly id: string;
  readonly category: TypeCategory;
  readonly summary: string;
  readonly displayName?: string;
  readonly aliases?: readonly string[];
  readonly parameters?: readonly TypeParameterDescriptor[];
  readonly preferred?: boolean;
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
    deprecated: false,
    summary: spec.summary,
  };
}

const number = (name: string, label: string, max: number): TypeParameterDescriptor => ({
  kind: 'number',
  name,
  label,
  required: false,
  min: 0,
  max,
  default: null,
});

const length = number('length', 'Length (not enforced)', 1_000_000_000);

const SPECS: readonly TypeSpec[] = [
  {
    id: 'integer',
    category: 'numeric',
    aliases: ['int'],
    preferred: true,
    summary: 'Whole number; INTEGER PRIMARY KEY is the rowid',
  },
  { id: 'bigint', category: 'numeric', summary: 'Whole number (INTEGER affinity)' },
  { id: 'smallint', category: 'numeric', summary: 'Whole number (INTEGER affinity)' },
  { id: 'tinyint', category: 'numeric', summary: 'Whole number (INTEGER affinity)' },
  { id: 'real', category: 'numeric', summary: '8-byte floating point' },
  {
    id: 'double',
    category: 'numeric',
    aliases: ['double precision'],
    summary: 'Floating point (REAL affinity)',
  },
  { id: 'float', category: 'numeric', summary: 'Floating point (REAL affinity)' },
  { id: 'numeric', category: 'numeric', summary: 'Stored as an integer or real when it fits' },
  {
    id: 'decimal',
    category: 'numeric',
    displayName: 'decimal(p,s)',
    parameters: [number('precision', 'Precision', 1000), number('scale', 'Scale', 1000)],
    summary: 'NUMERIC affinity; the precision is not enforced',
  },
  { id: 'boolean', category: 'boolean', summary: '0 or 1 (NUMERIC affinity)', preferred: true },
  { id: 'text', category: 'string', preferred: true, summary: 'Text of any length' },
  {
    id: 'varchar',
    category: 'string',
    aliases: ['character varying', 'nvarchar'],
    parameters: [length],
    summary: 'Text (TEXT affinity); the length is not enforced',
  },
  {
    id: 'char',
    category: 'string',
    aliases: ['character', 'nchar'],
    parameters: [length],
    summary: 'Text (TEXT affinity); the length is not enforced',
  },
  { id: 'clob', category: 'string', summary: 'Text (TEXT affinity)' },
  { id: 'blob', category: 'binary', preferred: true, summary: 'Bytes, stored as given' },
  { id: 'date', category: 'temporal', summary: 'A date, usually ISO-8601 text' },
  {
    id: 'datetime',
    category: 'temporal',
    preferred: true,
    summary: 'Date and time, usually ISO-8601 text',
  },
  { id: 'timestamp', category: 'temporal', summary: 'Date and time (NUMERIC affinity)' },
  { id: 'time', category: 'temporal', summary: 'Time of day, usually text' },
  {
    id: 'json',
    category: 'json',
    preferred: true,
    summary: 'JSON text (the json functions read it)',
  },
  { id: 'any', category: 'other', summary: 'Any value, in a STRICT table' },
];

export const TYPE_DESCRIPTORS: readonly TypeDescriptor[] = SPECS.map(describe);

/** The types a STRICT table accepts. */
export const STRICT_TYPES = new Set(['int', 'integer', 'real', 'text', 'blob', 'any']);

export type Affinity = 'INTEGER' | 'TEXT' | 'BLOB' | 'REAL' | 'NUMERIC';

/** SQLite's own rules (https://sqlite.org/datatype3.html §3.1), in their order. */
export function affinityOf(declared: string): Affinity {
  const name = declared.toUpperCase();
  if (name.includes('INT')) return 'INTEGER';
  if (name.includes('CHAR') || name.includes('CLOB') || name.includes('TEXT')) return 'TEXT';
  if (name.includes('BLOB') || name.trim() === '') return 'BLOB';
  if (name.includes('REAL') || name.includes('FLOA') || name.includes('DOUB')) return 'REAL';
  return 'NUMERIC';
}

/** Columns of these may be joined by a foreign key; SQLite compares by affinity. */
const COMPATIBILITY_GROUPS: readonly (readonly string[])[] = [
  ['integer', 'bigint', 'smallint', 'tinyint'],
  ['text', 'varchar', 'char', 'clob'],
  ['real', 'double', 'float'],
];

export const TYPE_CATALOG: TypeCatalog = createTypeCatalog({
  descriptors: TYPE_DESCRIPTORS,
  arraySyntax: 'none',
  compatibilityGroups: COMPATIBILITY_GROUPS,
  userTypeGroups: {},
});
