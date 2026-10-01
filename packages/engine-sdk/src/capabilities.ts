import type {
  Cardinality,
  ConstraintKind,
  CustomTypeKind,
  EntityKind,
  IndexKind,
  LinkKind,
  OpenKind,
} from './ir.js';
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
  /** Phase 6 §1 — the form for reading a live database. Empty when the engine has no
   *  `introspector`; `capabilities/services-match-features` checks the two agree. Here and not
   *  on the introspector because the browser only ever sees capabilities. */
  readonly connectionFields: readonly ConnectionField[];
}

/** Phase 6 §1 — one input of the "From a database" form. `secret` renders as a password
 *  input and is never echoed back by the api. `file` is PEM text (§10.1). */
export interface ConnectionField {
  readonly id: string;
  readonly label: string;
  readonly kind: 'text' | 'number' | 'secret' | 'select' | 'list' | 'file';
  readonly required: boolean;
  /** for `select` */
  readonly options?: readonly string[];
  readonly default?: string | number;
  /** heading the web groups fields under */
  readonly section?: string;
  /** shown, validated and sent only while `field` is visible and its value is in `in` */
  readonly showWhen?: { readonly field: string; readonly in: readonly string[] };
  /** Phase 6c — a `file` holding a private key. With `kind: 'secret'` it is what a saved
   *  connection keeps encrypted and never returns to a browser. */
  readonly secret?: boolean;
}

/** Phase 6c — the fields a saved connection never returns. */
export const isSecretField = (field: ConnectionField): boolean =>
  field.kind === 'secret' || field.secret === true;

/**
 * Phase 6 §10.1 — the one visibility rule, shared by the web form and the api's validation.
 * Transitive: a field whose controller is hidden is hidden too. `values` are raw inputs; an
 * empty controller reads as its default.
 */
export function visibleFields(
  fields: readonly ConnectionField[],
  values: Readonly<Record<string, unknown>>,
): readonly ConnectionField[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  const visible = (field: ConnectionField, depth: number): boolean => {
    if (field.showWhen === undefined) return true;
    const controller = byId.get(field.showWhen.field);
    // A cycle or a dangling reference hides the field rather than looping or guessing.
    if (controller === undefined || depth > fields.length || !visible(controller, depth + 1)) {
      return false;
    }
    const raw = values[controller.id];
    const value = raw === undefined || raw === '' ? controller.default : raw;
    return (
      (typeof value === 'string' || typeof value === 'number') &&
      field.showWhen.in.includes(String(value))
    );
  };
  return fields.filter((f) => visible(f, 0));
}

/** Phase 6 §10.3 — the SSH part of the form. Core opens the tunnel, so these ids are
 *  conventions core reads; an engine that talks TCP spreads this into `connectionFields`. */
export const SSH_TUNNEL_FIELDS: readonly ConnectionField[] = [
  {
    id: 'ssh',
    label: 'Connect through',
    kind: 'select',
    required: true,
    options: ['none', 'ssh'],
    default: 'none',
    section: 'SSH tunnel',
  },
  ...(
    [
      { id: 'ssh_host', label: 'SSH host', kind: 'text', required: true },
      { id: 'ssh_port', label: 'SSH port', kind: 'number', required: true, default: 22 },
      { id: 'ssh_user', label: 'SSH user', kind: 'text', required: true },
      {
        id: 'ssh_auth',
        label: 'SSH login',
        kind: 'select',
        required: true,
        options: ['key', 'password'],
        default: 'key',
      },
      {
        id: 'ssh_host_key',
        label: 'Host key fingerprint (SHA256:…, optional)',
        kind: 'text',
        required: false,
      },
    ] as const
  ).map((f) => ({ ...f, section: 'SSH tunnel', showWhen: { field: 'ssh', in: ['ssh'] } })),
  ...(
    [
      { id: 'ssh_private_key', label: 'Private key', kind: 'file', required: true, secret: true },
      { id: 'ssh_passphrase', label: 'Key passphrase', kind: 'secret', required: false },
    ] as const
  ).map((f) => ({ ...f, section: 'SSH tunnel', showWhen: { field: 'ssh_auth', in: ['key'] } })),
  {
    id: 'ssh_password',
    label: 'SSH password',
    kind: 'secret',
    required: true,
    section: 'SSH tunnel',
    showWhen: { field: 'ssh_auth', in: ['password'] },
  },
];

export interface CapabilitiesInput extends Omit<
  EngineCapabilities,
  'features' | 'typeCatalogSupportsArrays' | 'connectionFields'
> {
  /** defaults to none: an engine without an introspector declares nothing */
  readonly connectionFields?: readonly ConnectionField[];
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
export const canIntrospect = (c: EngineCapabilities): boolean => c.connectionFields.length > 0;
