/**
 * `@schemaloom/engine-sdk` — the "." entry.
 *
 * C10: this package depends on `@schemaloom/schema-model` and `zod`. Nothing else. It imports
 * no React, no NestJS, no Prisma and no Node built-in, because the same module is loaded in the
 * browser. Nothing in core imports a concrete engine; everything resolves through
 * `EngineRegistry` by `project.engineId`.
 *
 * Build-order step 7 ships the static half plus the registry. `./ui` (§16), `./conformance`
 * (§17) and the validator / importer / exporter / migration / query / AI contracts land in
 * later steps — see the note on `EngineDefinition`.
 */

// --- IR coupling point (§2.1) ---
export type {
  Area,
  Cardinality,
  Constraint,
  ConstraintKind,
  CustomType,
  CustomTypeKind,
  DocRef,
  EngineProps,
  Entity,
  EntityKind,
  Field,
  Id,
  Index,
  IndexColumn,
  IndexKind,
  IrBase,
  IrObject,
  IrObjectRef,
  IrObjectType,
  Link,
  LinkEndpoint,
  LinkKind,
  Namespace,
  ObjectRefs,
  OpenKind,
  SchemaModel,
  TypeRef,
} from './ir.js';
export { IR_OBJECT_TYPES, MAX_FIELD_DEPTH } from './ir.js';

// --- diagnostics (§2.2–§2.5) ---
export {
  diagnosticTypeRank,
  renderDiagnostic,
  sortDiagnostics,
  type Diagnostic,
  type DiagnosticMessages,
  type DiagnosticParam,
  type DiagnosticSeverity,
  type DiagnosticTarget,
  type EngineContext,
  type EngineId,
  type EnginePropsKind,
  type QuickFix,
  type QuickFixEdit,
  type SourceRange,
} from './diagnostics.js';

// --- terminology (§16.2; no React, exported from both entries) ---
export {
  CORE_MESSAGE_TEMPLATES,
  FALLBACK_TERMINOLOGY,
  formatMessage,
  resolveTerm,
  type CoreMessageId,
  type CoreTermKey,
  type Term,
  type TerminologyBundle,
  type TermSubject,
} from './terminology.js';

// --- capabilities (§4) ---
export {
  ENGINE_FEATURES,
  anyCompositeEndpoint,
  anyIndexTypeUnique,
  anyLinkKindEnforced,
  anyLinkKindHasFields,
  anySchemalessEntity,
  anyTypeSupportsArray,
  canExport,
  canImport,
  hasConstraintKind,
  hasCustomTypeKind,
  hasEntityKind,
  supportsNamespaces,
  type CapabilitiesInput,
  type ConstraintKindDescriptor,
  type CustomTypeKindDescriptor,
  type EngineCapabilities,
  type EngineFeature,
  type EntityKindDescriptor,
  type ExportFormatDescriptor,
  type IdentifierRules,
  type ImportFormatDescriptor,
  type IndexTypeDescriptor,
  type LinkKindDescriptor,
  type NamespaceSupport,
  type QueryLanguageDescriptor,
} from './capabilities.js';
export { assertFeature, defineCapabilities } from './define-capabilities.js';

// --- type catalog (§5) ---
export {
  CATEGORY_GROUPS,
  type BuildTypeRefInput,
  type ResolvedType,
  type ResolveType,
  type TypeCatalog,
  type TypeCatalogOptions,
  type TypeCategory,
  type TypeDescriptor,
  type TypeParameterDescriptor,
  type TypePickerOption,
  type TypeResolutionContext,
  type TypeResolutionStatus,
} from './type-catalog.js';
export { createTypeCatalog } from './create-type-catalog.js';

// --- engineProps (§6) ---
export {
  constantProps,
  parseEngineProps,
  type EnginePropsResolver,
  type EnginePropsSchemas,
  type ParseEnginePropsResult,
} from './props.js';

// --- link rules (§7) ---
export {
  checkLink,
  type LinkCheck,
  type LinkCheckInput,
  type LinkCheckReason,
} from './links.js';

// --- the engine itself (§3) ---
export type { EngineDefinition, EngineParadigm, EngineStaticFacet } from './definition.js';

// --- registry (§14) ---
export {
  createEngineRegistry,
  type AnnouncedEngine,
  type EngineCatalog,
  type EngineDescriptor,
  type EngineRegistry,
} from './registry.js';

// --- versioning (§15) ---
export { compareEngineVersion, type EngineVersionVerdict } from './versioning.js';

// --- errors (§14.1) ---
export {
  CapabilitiesContradictionError,
  DuplicateEngineError,
  EngineError,
  EngineFeatureUnsupportedError,
  UnknownEngineError,
} from './errors.js';
