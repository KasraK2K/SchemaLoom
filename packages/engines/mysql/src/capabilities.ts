import {
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
 * What the MySQL / MariaDB engine supports (design §3). The `features` flags track the
 * services this package ships: migrations, query validation and reading a live database
 * arrive in steps 9b–9d, and conformance holds each flag to its service.
 */

export const FOREIGN_KEY_KIND: LinkKindDescriptor = {
  id: 'foreignKey',
  directed: true,
  enforced: true,
  endpointLevel: 'field',
  compositeEndpoints: true,
  hasFields: false,
  cardinalities: ['1:1', '1:N', 'N:1'],
  defaultCardinality: 'N:1',
  requireSameNamespace: true,
  requireTypeCompatibility: true,
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
    summary: 'The default: equality and range queries, ordered scans, unique keys',
  },
  {
    id: 'fulltext',
    displayName: 'Full-text',
    isDefault: false,
    supportsUnique: false,
    supportsMultipleColumns: true,
    supportsOrdering: false,
    summary: 'Word search over CHAR, VARCHAR and TEXT columns (MATCH … AGAINST)',
  },
  {
    id: 'spatial',
    displayName: 'Spatial',
    isDefault: false,
    supportsUnique: false,
    supportsMultipleColumns: false,
    supportsOrdering: false,
    summary: 'R-tree index over one NOT NULL geometry column',
  },
];

const CONSTRAINT_KINDS: readonly ConstraintKindDescriptor[] = [
  { id: 'primaryKey', scope: 'entity', maxPerEntity: 1, hasExpression: false },
  { id: 'unique', scope: 'entity', maxPerEntity: null, hasExpression: false },
  { id: 'check', scope: 'entity', maxPerEntity: null, hasExpression: true },
];

export const CAPABILITIES: EngineCapabilities = defineCapabilities({
  engineId: 'mysql',
  features: {
    nestedFields: false,
    notNull: true,
    links: true,
    referentialActions: true,
    indexes: true,
    expressionIndexes: true,
    includeColumns: false,
    comments: true,
    migrations: true,
    queryValidation: true,
  },
  typeDescriptors: TYPE_DESCRIPTORS,
  // Q4: a project is one database.
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
    quoteOpen: '`',
    quoteClose: '`',
    validUnquoted: '^[A-Za-z_$][A-Za-z0-9_$]*$',
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
  // Q7: the current LTS lines. A version names its product, so the picker shows it as is.
  targetVersions: ['MySQL 8.4', 'MySQL 8.0', 'MariaDB 11.4', 'MariaDB 10.11'],
  defaultTargetVersion: 'MySQL 8.4',
  // 9b adds the "Read a database" form with the introspector.
  connectionFields: [],
});

/** The target version picks the dialect: `MariaDB 11.4` → MariaDB, anything else MySQL. */
export function isMariaDb(engineVersion: string | null | undefined): boolean {
  return /mariadb/i.test(engineVersion ?? '');
}
