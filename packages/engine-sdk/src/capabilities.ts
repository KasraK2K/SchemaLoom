import type { Cardinality, ConstraintKind, CustomTypeKind, EntityKind, IndexKind, LinkKind, OpenKind } from './ir.js';
import type { TypeDescriptor } from './type-catalog.js';

/**
 * The 10 feature atoms doc 03 §4 settled on. The first draft had 33, of which fourteen
 * restated a fact that also lived on a descriptor — duplicated truth in a capability record is
 * how an engine self-contradicts. An atom exists only when nothing else in
 * `EngineCapabilities` already answers the question; where core wants one of the deleted
 * booleans it calls a derived helper below.
 *
 * Boolean atoms are a TOTAL record defaulting to `false`, so a new atom never silently
 * switches itself on for an engine that was never tested with it.
 */
export const ENGINE_FEATURES = [
  // fields
  'nestedFields',
  'notNull',
  // links
  'links',
  'referentialActions',
  // indexes
  'indexes',
  'expressionIndexes',
  'includeColumns',
  // engine services
  'comments',
  'migrations',
  'queryValidation',
] as const;

export type EngineFeature = (typeof ENGINE_FEATURES)[number];

export type NamespaceSupport = 'none' | 'optional' | 'required';

/** Kind ids are camelCase across every descriptor: `['table', 'view', 'materializedView']`. */
export interface EntityKindDescriptor {
  readonly id: EntityKind;
  /** One or two UPPERCASE letters, unique across `entityKinds`. The AI context format prefixes
   *  every entity line with it. Not derived from the id, because two kinds starting with the
   *  same letter would silently collide in a format the model parses. */
  readonly shortCode: string;
  readonly icon: string;
  /** false for a Redis key pattern: the card renders a description, not a field list */
  readonly hasFields: boolean;
  /** false for schemaless stores: fields are an observed sample, shown as "inferred" and never
   *  exported as a hard contract */
  readonly fieldsAreAuthoritative: boolean;
  readonly supportsIndexes: boolean;
  readonly supportsConstraints: boolean;
  readonly canBeLinkEndpoint: boolean;
}

export interface LinkKindDescriptor {
  readonly id: LinkKind;
  /** false renders an undirected line */
  readonly directed: boolean;
  /** true = the database enforces it. false = documentation-only; core hides ON DELETE /
   *  ON UPDATE and labels the link "logical" on the canvas. */
  readonly enforced: boolean;
  /** 'field' = endpoints are fields (FK). 'entity' = endpoints are whole entities (graph edge,
   *  embedded document). Drives what the drag handle attaches to. */
  readonly endpointLevel: 'entity' | 'field';
  /** multi-field endpoints (composite FK) */
  readonly compositeEndpoints: boolean;
  /** true = the link itself owns fields (Neo4j relationship properties) */
  readonly hasFields: boolean;
  readonly cardinalities: readonly Cardinality[];
  readonly defaultCardinality: Cardinality;
  readonly requireSameNamespace: boolean;
  readonly requireTypeCompatibility: boolean;
  readonly allowSelfReference: boolean;
  /** '*' = any entity kind */
  readonly allowedSourceEntityKinds: readonly string[] | '*';
  readonly allowedTargetEntityKinds: readonly string[] | '*';
}

export interface IndexTypeDescriptor {
  readonly id: IndexKind;
  readonly displayName: string;
  readonly isDefault: boolean;
  readonly supportsUnique: boolean;
  readonly supportsMultipleColumns: boolean;
  /** per-column ASC/DESC/NULLS FIRST */
  readonly supportsOrdering: boolean;
  readonly summary: string;
}

export interface ConstraintKindDescriptor {
  readonly id: ConstraintKind;
  readonly scope: 'field' | 'entity';
  /** 1 for primaryKey, null for unlimited */
  readonly maxPerEntity: number | null;
  /** true = the constraint body is an engine expression in `engineProps`, so it needs the
   *  engine's constraint editor and participates in `extractReferences` (§3.1) */
  readonly hasExpression: boolean;
}

export interface CustomTypeKindDescriptor {
  readonly id: CustomTypeKind;
  /** true = instances appear in the field type picker as a group (§5.4) */
  readonly usableAsFieldType: boolean;
}

export interface QueryLanguageDescriptor {
  readonly id: OpenKind<'sql' | 'mongo-aggregation' | 'cypher' | 'cql' | 'redis'>;
  readonly displayName: string;
  readonly fileExtension: string;
  /** id the UI plugin resolves to a CodeMirror LanguageSupport; core falls back to plain text */
  readonly codeMirrorMode: string;
  readonly lineComment: string;
  /** ';' or null when statements are not separable */
  readonly statementSeparator: string | null;
}

export interface IdentifierRules {
  readonly maxLength: number;
  readonly caseSensitive: boolean;
  /** unquoted identifier folding */
  readonly foldsTo: 'lower' | 'upper' | 'none';
  readonly quoteOpen: string;
  readonly quoteClose: string;
  /** serialisable regex source, for client-side hints */
  readonly validUnquoted: string;
  readonly reservedWords: readonly string[];
}

export interface ImportFormatDescriptor {
  readonly id: string;
  readonly displayName: string;
  /** the file picker's `accept` list. No `mimeTypes`: browsers report '' or
   *  'application/octet-stream' for .sql, so a MIME list is wrong exactly when it matters. */
  readonly fileExtensions: readonly string[];
  readonly maxBytes: number;
}

export interface ExportFormatDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly fileExtension: string;
  readonly supportsComments: boolean;
  readonly supportsDrops: boolean;
}

/** Pure JSON: served to the browser by `GET /engines` and cached in the project store. No
 *  functions, no classes — that is what lets the fallback UI gate features for an engine that
 *  ships no UI package at all. */
export interface EngineCapabilities {
  readonly features: Readonly<Record<EngineFeature, boolean>>;
  readonly namespaces: NamespaceSupport;
  /** the name pre-filled for the implicit namespace ('public'); null when `namespaces: 'none'` */
  readonly defaultNamespaceName: string | null;
  readonly entityKinds: readonly EntityKindDescriptor[];
  readonly linkKinds: readonly LinkKindDescriptor[];
  readonly indexTypes: readonly IndexTypeDescriptor[];
  readonly constraintKinds: readonly ConstraintKindDescriptor[];
  readonly customTypeKinds: readonly CustomTypeKindDescriptor[];
  /** 1 = flat fields only; >1 = document nesting depth cap for the field tree UI */
  readonly maxFieldDepth: number;
  /** derived by `defineCapabilities` from the type catalog, so the array checkbox in the type
   *  picker is one boolean read rather than a scan over hundreds of descriptors */
  readonly typeCatalogSupportsArrays: boolean;
  readonly identifiers: IdentifierRules;
  readonly queryLanguage: QueryLanguageDescriptor;
  readonly importFormats: readonly ImportFormatDescriptor[];
  readonly exportFormats: readonly ExportFormatDescriptor[];
}

export interface CapabilitiesInput
  extends Omit<EngineCapabilities, 'features' | 'typeCatalogSupportsArrays'> {
  /** DEVIATION from doc 03 §4.1, which omits it: `CapabilitiesContradictionError` is specified
   *  to carry `engineId`, and `defineCapabilities` sees only this object. */
  readonly engineId: string;
  /** unlisted atoms default to false */
  readonly features: Partial<Record<EngineFeature, boolean>>;
  /** read once to fill `typeCatalogSupportsArrays` */
  readonly typeDescriptors: readonly TypeDescriptor[];
}

// The derived helpers that replaced the deleted atoms. Each is a one-liner, exported so core
// reads the answer from exactly one place.

export const supportsNamespaces = (c: EngineCapabilities): boolean => c.namespaces !== 'none';
export const anyLinkKindEnforced = (c: EngineCapabilities): boolean =>
  c.linkKinds.some((k) => k.enforced);
export const anyCompositeEndpoint = (c: EngineCapabilities): boolean =>
  c.linkKinds.some((k) => k.compositeEndpoints);
export const anyLinkKindHasFields = (c: EngineCapabilities): boolean =>
  c.linkKinds.some((k) => k.hasFields);
export const anyIndexTypeUnique = (c: EngineCapabilities): boolean =>
  c.indexTypes.some((i) => i.supportsUnique);
/** reads the precomputed boolean rather than scanning descriptors: the catalog can be large and
 *  the answer never changes */
export const anyTypeSupportsArray = (c: EngineCapabilities): boolean => c.typeCatalogSupportsArrays;
export const hasEntityKind = (c: EngineCapabilities, id: string): boolean =>
  c.entityKinds.some((k) => k.id === id);
export const hasConstraintKind = (c: EngineCapabilities, id: string): boolean =>
  c.constraintKinds.some((k) => k.id === id);
export const hasCustomTypeKind = (c: EngineCapabilities, id: string): boolean =>
  c.customTypeKinds.some((k) => k.id === id);
export const anySchemalessEntity = (c: EngineCapabilities): boolean =>
  c.entityKinds.some((k) => !k.fieldsAreAuthoritative);
export const canImport = (c: EngineCapabilities): boolean => c.importFormats.length > 0;
export const canExport = (c: EngineCapabilities): boolean => c.exportFormats.length > 0;
