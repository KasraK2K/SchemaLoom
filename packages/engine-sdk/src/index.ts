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
  RedactedModel,
  SchemaModel,
  TypeRef,
  DiffEntry,
  PropertyChange,
  PropertySeverity,
  SchemaDiff,
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
  canIntrospect,
  hasConstraintKind,
  hasCustomTypeKind,
  hasEntityKind,
  supportsNamespaces,
  type CapabilitiesInput,
  SSH_TUNNEL_FIELDS,
  ORM_EXPORT_FORMATS,
  PRISMA_IMPORT_FORMAT,
  isSecretField,
  type ConnectionField,
  visibleFields,
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
export { checkLink, type LinkCheck, type LinkCheckInput, type LinkCheckReason } from './links.js';

// --- importer (§9) ---
export {
  IMPORT_STATEMENT_STATUSES,
  type ImportContext,
  type ImportedDoc,
  type ImportOptions,
  type ImportReport,
  type ImportResult,
  type ImportStatementReport,
  type ImportStatementStatus,
  type Importer,
} from './importer.js';

// --- introspector (Phase 6 §1) ---
export {
  IntrospectError,
  type ConnectionValues,
  type IntrospectErrorCode,
  type IntrospectRequest,
  type IntrospectResult,
  type Introspector,
} from './introspector.js';

// --- exporter (§10) ---
export {
  EXPORT_PHASE_ORDER,
  EXPORT_PHASE_RANK,
  renderStatements,
  type ExportInput,
  type ExportOptions,
  type ExportPhase,
  type ExportResult,
  type ExportStatement,
  type Exporter,
  type RenderStatementsOptions,
} from './exporter.js';

// --- migrations (§11) ---
export {
  DESTRUCTIVE_REMOVALS,
  MIGRATION_OPERATION_ORDER,
  MIGRATION_PHASE_ORDER,
  PROPERTY_SEVERITY_RANK,
  compareMigrationSteps,
  entryIsDestructive,
  entryRiskKey,
  needsMigrationStep,
  renderMigrationScript,
  type AnnotatedDiff,
  type EntryRisk,
  type MigrationGenerator,
  type MigrationInput,
  type MigrationOperation,
  type MigrationOptions,
  type MigrationPhase,
  type MigrationPlan,
  type MigrationStep,
  type RenderMigrationOptions,
  type UnsupportedChange,
} from './migration.js';

// --- query validator (§12) ---
export type {
  IdentifierResolution,
  IdentifierRole,
  QueryParseError,
  QueryValidationInput,
  QueryValidationResult,
  QueryValidator,
  ResolutionStatus,
} from './query.js';

// --- AI profile (§13) ---
export {
  AI_MODES,
  DEFAULT_AI_CONTEXT_OPTIONS,
  approxTokens,
  createTaggedBlockStream,
  defaultJoinPaths,
  firstFencedBlock,
  parseAiOutput,
  parseTaggedOutput,
  type AiContextOptions,
  type AiDocSuggestion,
  type AiMode,
  type AiOutputEvent,
  type AiParsedOutput,
  type AiProfile,
  type AiPromptContext,
  type AiSerializedContext,
  type JoinPathInput,
  type JoinPathStep,
  type JoinPathSuggestion,
  type ParseAiOutputOptions,
  type TaggedBlock,
} from './ai.js';

// --- templates (Phase 12) ---
export type { ProjectTemplate, ProjectTemplateSummary } from './templates.js';

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
export {
  compareEngineVersion,
  majorOf,
  propsUpgradePath,
  type EngineVersionVerdict,
  type PropsUpgrade,
} from './versioning.js';

// --- conformance suite (§17) ---
// NOT re-exported here, and the reason is load-bearing rather than tidiness: the suite calls
// vitest's `describe`/`it`, so re-exporting it makes `vitest` a static import of THIS entry —
// and `apps/api` is CommonJS, so `require('@schemaloom/engine-sdk')` then throws
// "Vitest cannot be imported in a CommonJS module using require()" before a line of it runs.
// It ships from `@schemaloom/engine-sdk/conformance`, exactly as §17 says.

// --- errors (§14.1) ---
export {
  CapabilitiesContradictionError,
  DuplicateEngineError,
  EngineError,
  EngineFeatureUnsupportedError,
  UnknownEngineError,
} from './errors.js';
