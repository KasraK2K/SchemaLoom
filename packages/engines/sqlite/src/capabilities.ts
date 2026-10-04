import {
  ORM_EXPORT_FORMATS,
  PRISMA_IMPORT_FORMAT,
  defineCapabilities,
  type ConstraintKindDescriptor,
  type EngineCapabilities,
  type EntityKindDescriptor,
  type IndexTypeDescriptor,
  type LinkKindDescriptor,
} from '@schemaloom/engine-sdk';
import { MAX_IDENTIFIER_LENGTH } from './normalize-name.js';
import { RESERVED_WORDS } from './reserved-words.js';
import { TYPE_DESCRIPTORS } from './types.js';

/**
 * What the SQLite engine supports (`docs/phase13/DESIGN.md` §1). A project is one database
 * file with no schemas; reading a live database means uploading that file (§5), so there are
 * no connection fields.
 */

const FOREIGN_KEY_KIND: LinkKindDescriptor = {
  id: 'foreignKey',
  directed: true,
  enforced: true,
  endpointLevel: 'field',
  compositeEndpoints: true,
  hasFields: false,
  cardinalities: ['1:1', '1:N', 'N:1'],
  defaultCardinality: 'N:1',
  requireSameNamespace: true,
  requireTypeCompatibility: false,
  allowSelfReference: true,
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

const INDEX_TYPES: readonly IndexTypeDescriptor[] = [
  {
    id: 'btree',
    displayName: 'B-tree',
    isDefault: true,
    supportsUnique: true,
    supportsMultipleColumns: true,
    supportsOrdering: true,
    summary: 'SQLite’s only index type: equality, ranges, ordered scans, unique keys',
  },
];

const CONSTRAINT_KINDS: readonly ConstraintKindDescriptor[] = [
  { id: 'primaryKey', scope: 'entity', maxPerEntity: 1, hasExpression: false },
  { id: 'unique', scope: 'entity', maxPerEntity: null, hasExpression: false },
  { id: 'check', scope: 'entity', maxPerEntity: null, hasExpression: true },
];

export const CAPABILITIES: EngineCapabilities = defineCapabilities({
  engineId: 'sqlite',
  features: {
    nestedFields: false,
    notNull: true,
    links: true,
    referentialActions: true,
    indexes: true,
    expressionIndexes: true,
    includeColumns: false,
    // SQLite has no COMMENT; the DDL export writes docs as `--` lines.
    comments: true,
    migrations: true,
    queryValidation: true,
  },
  typeDescriptors: TYPE_DESCRIPTORS,
  // Q5: one database, no attached ones.
  namespaces: 'none',
  defaultNamespaceName: null,
  entityKinds: [TABLE_KIND, VIEW_KIND],
  linkKinds: [FOREIGN_KEY_KIND],
  indexTypes: INDEX_TYPES,
  constraintKinds: CONSTRAINT_KINDS,
  customTypeKinds: [],
  maxFieldDepth: 1,
  identifiers: {
    maxLength: MAX_IDENTIFIER_LENGTH,
    caseSensitive: false,
    foldsTo: 'none',
    quoteOpen: '"',
    quoteClose: '"',
    validUnquoted: '^[A-Za-z_][A-Za-z0-9_$]*$',
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
  importFormats: [
    {
      id: 'ddl',
      displayName: 'SQL DDL',
      fileExtensions: ['.sql', '.ddl'],
      maxBytes: 10_000_000,
    },
    PRISMA_IMPORT_FORMAT,
  ],
  exportFormats: [
    {
      id: 'ddl',
      displayName: 'SQL DDL',
      fileExtension: 'sql',
      supportsComments: true,
      supportsDrops: true,
    },
    ...ORM_EXPORT_FORMATS,
  ],
  // Q7: 3.35 brought DROP COLUMN and RETURNING; the generator never emits newer syntax.
  targetVersions: ['3.45', '3.40', '3.35'],
  defaultTargetVersion: '3.45',
  introspection: 'file',
});
