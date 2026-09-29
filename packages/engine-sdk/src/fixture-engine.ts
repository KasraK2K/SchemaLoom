import { z } from 'zod';
import type {
  CapabilitiesInput,
  EntityKindDescriptor,
  LinkKindDescriptor,
} from './capabilities.js';
import { createTypeCatalog } from './create-type-catalog.js';
import { defineCapabilities } from './define-capabilities.js';
import type { EngineDefinition, EngineStaticFacet } from './definition.js';
import { constantProps, type EnginePropsSchemas } from './props.js';
import { FALLBACK_TERMINOLOGY, type TerminologyBundle } from './terminology.js';
import type { SchemaModel } from './ir.js';
import type { TypeDescriptor } from './type-catalog.js';

/**
 * A small, internally-consistent relational engine, used only by this package's specs.
 * Not exported from `index.ts`, so it never reaches `dist`.
 */

export const TYPE_DESCRIPTORS: readonly TypeDescriptor[] = [
  {
    id: 'int4',
    displayName: 'integer',
    category: 'numeric',
    aliases: ['integer', 'int'],
    parameters: [],
    supportsArray: true,
    preferredForCategory: true,
    deprecated: false,
    summary: '32-bit signed integer',
  },
  {
    id: 'varchar',
    displayName: 'varchar(n)',
    category: 'string',
    aliases: ['character varying'],
    parameters: [
      {
        kind: 'number',
        name: 'length',
        label: 'Length',
        required: false,
        min: 1,
        max: 10485760,
        default: 255,
      },
    ],
    supportsArray: true,
    preferredForCategory: true,
    deprecated: false,
    summary: 'Variable-length text with a limit',
  },
  {
    id: 'numeric',
    displayName: 'numeric(p,s)',
    category: 'numeric',
    aliases: ['decimal'],
    parameters: [
      {
        kind: 'number',
        name: 'precision',
        label: 'Precision',
        required: false,
        min: 1,
        max: 1000,
        default: null,
      },
      {
        kind: 'number',
        name: 'scale',
        label: 'Scale',
        required: false,
        min: 0,
        max: 1000,
        default: null,
      },
    ],
    supportsArray: true,
    preferredForCategory: false,
    deprecated: false,
    summary: 'Exact numeric',
  },
  {
    id: 'geometry',
    displayName: 'geometry(type, srid)',
    category: 'geometric',
    aliases: [],
    parameters: [
      {
        kind: 'enum',
        name: 'subtype',
        label: 'Subtype',
        required: true,
        options: ['Point', 'LineString', 'Polygon'],
        default: 'Point',
      },
      {
        kind: 'number',
        name: 'srid',
        label: 'SRID',
        required: false,
        min: 0,
        max: 999999,
        default: 4326,
      },
    ],
    supportsArray: false,
    preferredForCategory: true,
    deprecated: false,
    summary: 'PostGIS geometry',
  },
];

export const TYPE_CATALOG = createTypeCatalog({
  descriptors: TYPE_DESCRIPTORS,
  arraySyntax: 'suffix-brackets',
  compatibilityGroups: [['int4', 'serial']],
  normalizeAliases: { serial: 'int4' },
  userTypeGroups: { enum: 'Enums', domain: 'Domains' },
});

export const TABLE_KIND: EntityKindDescriptor = {
  id: 'table',
  shortCode: 'T',
  icon: 'table',
  hasFields: true,
  fieldsAreAuthoritative: true,
  supportsIndexes: true,
  supportsConstraints: true,
  canBeLinkEndpoint: true,
};

export const VIEW_KIND: EntityKindDescriptor = {
  ...TABLE_KIND,
  id: 'view',
  shortCode: 'V',
  supportsIndexes: false,
  supportsConstraints: false,
  canBeLinkEndpoint: false,
};

export const FOREIGN_KEY_KIND: LinkKindDescriptor = {
  id: 'foreignKey',
  directed: true,
  enforced: true,
  endpointLevel: 'field',
  compositeEndpoints: true,
  hasFields: false,
  cardinalities: ['1:1', '1:N', 'N:1'],
  defaultCardinality: 'N:1',
  requireSameNamespace: false,
  requireTypeCompatibility: true,
  allowSelfReference: true,
  allowedSourceEntityKinds: ['table'],
  allowedTargetEntityKinds: ['table'],
};

/** A valid relational capabilities input. Specs clone and break one field at a time. */
export function relationalInput(overrides: Partial<CapabilitiesInput> = {}): CapabilitiesInput {
  return {
    engineId: 'fixturesql',
    features: {
      notNull: true,
      links: true,
      referentialActions: true,
      indexes: true,
      expressionIndexes: true,
      comments: true,
    },
    typeDescriptors: TYPE_DESCRIPTORS,
    namespaces: 'required',
    defaultNamespaceName: 'public',
    entityKinds: [TABLE_KIND, VIEW_KIND],
    linkKinds: [FOREIGN_KEY_KIND],
    indexTypes: [
      {
        id: 'btree',
        displayName: 'B-tree',
        isDefault: true,
        supportsUnique: true,
        supportsMultipleColumns: true,
        supportsOrdering: true,
        summary: 'The default balanced-tree index',
      },
    ],
    constraintKinds: [
      { id: 'primaryKey', scope: 'entity', maxPerEntity: 1, hasExpression: false },
      { id: 'unique', scope: 'entity', maxPerEntity: null, hasExpression: false },
      { id: 'check', scope: 'entity', maxPerEntity: null, hasExpression: true },
    ],
    customTypeKinds: [
      { id: 'enum', usableAsFieldType: true },
      { id: 'domain', usableAsFieldType: true },
    ],
    maxFieldDepth: 1,
    identifiers: {
      maxLength: 63,
      caseSensitive: false,
      foldsTo: 'lower',
      quoteOpen: '"',
      quoteClose: '"',
      validUnquoted: '^[a-z_][a-z0-9_$]*$',
      reservedWords: ['select', 'table'],
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
      { id: 'ddl', displayName: 'DDL (.sql)', fileExtensions: ['.sql'], maxBytes: 5_000_000 },
    ],
    exportFormats: [
      {
        id: 'ddl',
        displayName: 'DDL (.sql)',
        fileExtension: 'sql',
        supportsComments: true,
        supportsDrops: true,
      },
    ],
    ...overrides,
  };
}

const TABLE_PROPS = z.object({ fillfactor: z.number().int().min(10).max(100).optional() }).strict();
const NO_PROPS = z.object({}).strict();

const propsSchemas: EnginePropsSchemas = {
  namespace: constantProps(NO_PROPS),
  entity: (subKind) => (subKind === 'table' ? TABLE_PROPS : NO_PROPS),
  field: constantProps(z.object({ default: z.string().optional() }).strict()),
  link: constantProps(NO_PROPS),
  index: constantProps(NO_PROPS),
  constraint: constantProps(z.object({ expression: z.string().optional() }).strict()),
  customType: constantProps(NO_PROPS),
  indexColumn: constantProps(NO_PROPS),
};

export const TERMINOLOGY: TerminologyBundle = {
  ...FALLBACK_TERMINOLOGY,
  terms: {
    ...FALLBACK_TERMINOLOGY.terms,
    entity: { one: 'Table', other: 'Tables' },
    field: { one: 'Column', other: 'Columns' },
    namespace: { one: 'Schema', other: 'Schemas' },
  },
  entityKindTerms: {
    table: { one: 'Table', other: 'Tables' },
    view: { one: 'View', other: 'Views' },
  },
  linkKindTerms: { foreignKey: { one: 'Foreign key', other: 'Foreign keys' } },
};

export const fixtureFacet: EngineStaticFacet = {
  id: 'fixturesql',
  displayName: 'Fixture SQL',
  version: '1.4.2',
  paradigm: 'relational',
  icon: 'database',
  summary: 'A relational engine that exists only in this package’s tests',
  capabilities: defineCapabilities(relationalInput()),
  typeCatalog: TYPE_CATALOG,
  terminology: TERMINOLOGY,
  diagnosticMessages: {
    'fixturesql.props-invalid': '{message}',
    'fixturesql.link-type-mismatch': '{source} is not compatible with {target}',
  },
  propsSchemas,
  normalizeName: (s) => s.trim().toLowerCase(),
};

export const fixtureEngine: EngineDefinition = {
  ...fixtureFacet,
  extractReferences: () => [],
};

/** An empty model that specs fill in. */
export function emptyModel(overrides: Partial<SchemaModel> = {}): SchemaModel {
  return {
    irVersion: 1,
    projectId: 'p1',
    engineId: 'fixturesql',
    engineVersion: '16',
    redacted: false,
    objects: {
      area: {},
      namespace: {},
      customType: {},
      entity: {},
      field: {},
      constraint: {},
      index: {},
      link: {},
    },
    ...overrides,
  };
}
