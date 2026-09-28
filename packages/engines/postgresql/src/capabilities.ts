import {
  defineCapabilities,
  type ConstraintKindDescriptor,
  type CustomTypeKindDescriptor,
  type EngineCapabilities,
  type EntityKindDescriptor,
  type IndexTypeDescriptor,
  type LinkKindDescriptor,
} from '@schemaloom/engine-sdk';
import { NAMEDATALEN_BYTES } from './normalize-name.js';
import { RESERVED_WORDS } from './reserved-words.js';
import { TYPE_DESCRIPTORS } from './types.js';

/** `capabilities.linkKinds` IS the link rule set (doc 03 §7): declarative data the SDK's
 *  shared `checkLink` evaluates, so the canvas mid-drag and the server on write cannot
 *  drift. There is deliberately no `linkRules` function on the engine. */
export const FOREIGN_KEY_KIND: LinkKindDescriptor = {
  id: 'foreignKey',
  directed: true,
  enforced: true,
  endpointLevel: 'field',
  compositeEndpoints: true,
  hasFields: false,
  cardinalities: ['1:1', '1:N', 'N:1'],
  defaultCardinality: 'N:1',
  // PostgreSQL happily references a table in another schema.
  requireSameNamespace: false,
  requireTypeCompatibility: true,
  allowSelfReference: true,
  // Only tables. A view has no unique index to reference, and a materialized view cannot
  // be the target of a foreign key at all.
  allowedSourceEntityKinds: ['table'],
  allowedTargetEntityKinds: ['table'],
};

const TABLE_KIND: EntityKindDescriptor = {
  id: 'table',
  shortCode: 'T',
  icon: 'table',
  hasFields: true,
  fieldsAreAuthoritative: true,
  supportsIndexes: true,
  supportsConstraints: true,
  canBeLinkEndpoint: true,
};

const VIEW_KIND: EntityKindDescriptor = {
  id: 'view',
  shortCode: 'V',
  icon: 'eye',
  hasFields: true,
  fieldsAreAuthoritative: true,
  supportsIndexes: false,
  supportsConstraints: false,
  canBeLinkEndpoint: false,
};

/** Unlike a plain view, a materialized view is a real heap: it can be indexed, which is
 *  most of the reason to make one. It still cannot carry constraints or take part in a
 *  foreign key. */
const MATERIALIZED_VIEW_KIND: EntityKindDescriptor = {
  ...VIEW_KIND,
  id: 'materializedView',
  shortCode: 'MV',
  icon: 'layers',
  supportsIndexes: true,
};

const INDEX_TYPES: readonly IndexTypeDescriptor[] = [
  {
    id: 'btree',
    displayName: 'B-tree',
    isDefault: true,
    supportsUnique: true,
    supportsMultipleColumns: true,
    supportsOrdering: true,
    summary: 'The default: equality and range queries, ordered scans, unique keys',
  },
  {
    id: 'hash',
    displayName: 'Hash',
    isDefault: false,
    supportsUnique: false,
    supportsMultipleColumns: false,
    supportsOrdering: false,
    summary: 'Equality only, on one column',
  },
  {
    id: 'gin',
    displayName: 'GIN',
    isDefault: false,
    supportsUnique: false,
    supportsMultipleColumns: true,
    supportsOrdering: false,
    summary: 'Inverted index for composite values: jsonb, arrays, full-text search',
  },
  {
    id: 'gist',
    displayName: 'GiST',
    isDefault: false,
    supportsUnique: false,
    supportsMultipleColumns: true,
    supportsOrdering: false,
    summary: 'Geometric, range and nearest-neighbour searches; backs EXCLUDE constraints',
  },
  {
    id: 'brin',
    displayName: 'BRIN',
    isDefault: false,
    supportsUnique: false,
    supportsMultipleColumns: true,
    supportsOrdering: false,
    summary: 'Tiny summary index for very large, naturally ordered tables',
  },
];

/** The index access methods that accept an `INCLUDE` payload column. */
export const INCLUDE_CAPABLE_INDEX_KINDS: ReadonlySet<string> = new Set(['btree', 'gist']);

const CONSTRAINT_KINDS: readonly ConstraintKindDescriptor[] = [
  { id: 'primaryKey', scope: 'entity', maxPerEntity: 1, hasExpression: false },
  { id: 'unique', scope: 'entity', maxPerEntity: null, hasExpression: false },
  { id: 'check', scope: 'entity', maxPerEntity: null, hasExpression: true },
  { id: 'exclusion', scope: 'entity', maxPerEntity: null, hasExpression: true },
];

const CUSTOM_TYPE_KINDS: readonly CustomTypeKindDescriptor[] = [
  { id: 'enum', usableAsFieldType: true },
  { id: 'domain', usableAsFieldType: true },
  { id: 'composite', usableAsFieldType: true },
];

export const CAPABILITIES: EngineCapabilities = defineCapabilities({
  engineId: 'postgresql',
  features: {
    // PostgreSQL rows are flat. A jsonb column is ONE column with an opaque value, not a
    // field tree, so `nestedFields` stays false and `maxFieldDepth` stays 1.
    nestedFields: false,
    notNull: true,
    links: true,
    referentialActions: true,
    indexes: true,
    expressionIndexes: true,
    includeColumns: true,
    comments: true,
    // The atoms must equal the presence of `migrationGenerator` (Phase 4, not shipped) and
    // `queryValidator` (Phase 2, shipped) on the definition
    // (`capabilities/services-match-features`).
    migrations: false,
    queryValidation: true,
  },
  typeDescriptors: TYPE_DESCRIPTORS,
  namespaces: 'required',
  defaultNamespaceName: 'public',
  entityKinds: [TABLE_KIND, VIEW_KIND, MATERIALIZED_VIEW_KIND],
  linkKinds: [FOREIGN_KEY_KIND],
  indexTypes: INDEX_TYPES,
  constraintKinds: CONSTRAINT_KINDS,
  customTypeKinds: CUSTOM_TYPE_KINDS,
  maxFieldDepth: 1,
  identifiers: {
    maxLength: NAMEDATALEN_BYTES,
    caseSensitive: false,
    foldsTo: 'lower',
    quoteOpen: '"',
    quoteClose: '"',
    validUnquoted: '^[a-z_][a-z0-9_$]*$',
    reservedWords: RESERVED_WORDS,
  },
  queryLanguage: {
    id: 'sql',
    displayName: 'SQL',
    fileExtension: 'sql',
    codeMirrorMode: 'sql',
    lineComment: '--',
    statementSeparator: ';',
  },
  // The descriptors, not the services: `importer` lands at build-order step 21 and
  // `exporter` at step 20. These describe what the engine will accept and produce, which
  // is what the file picker and the export dialog render.
  importFormats: [
    {
      id: 'ddl',
      displayName: 'SQL DDL',
      fileExtensions: ['.sql', '.ddl'],
      maxBytes: 10_000_000,
    },
  ],
  exportFormats: [
    {
      id: 'ddl',
      displayName: 'SQL DDL',
      fileExtension: 'sql',
      supportsComments: true,
      supportsDrops: true,
    },
  ],
});
