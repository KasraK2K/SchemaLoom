/**
 * `@schemaloom/engine-sdk/ui` — the browser surface (doc 03 §16).
 *
 * WHY THIS ENTRY EXISTS AT ALL: the react preset's `no-restricted-imports` forbids browser
 * code from importing the "." barrel, because that barrel is the server half's home and will
 * keep growing that way. Everything re-exported here is pure data or a pure function over
 * data — the same subset `EngineStaticFacet` is built from — so `apps/web` and an engine's UI
 * package get `formatMessage`, `checkLink` and the capability predicates without reaching for
 * the barrel.
 *
 * NO REACT. §16.1's React-typed plugin contract (`EngineUiPlugin`, `EngineNodeProps`,
 * `PropertyPanelSection`) is NOT here: this package must not gain a react dependency, since
 * `apps/api` resolves it too. That contract lives with a consumer that already has React —
 * see `@schemaloom/engine-postgresql-ui/contract`.
 *
 * Nothing here is new. Adding an export to this file is a decision about the browser
 * boundary, not a convenience: if it is not pure, it does not belong.
 */

// --- terminology (§16.2) — the reason the browser needs a runtime import at all ---
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
} from '../terminology.js';

// --- capabilities (§4) — every `available` predicate in §16.5 reads these ---
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
  SSH_TUNNEL_FIELDS,
  isSecretField,
  visibleFields,
  type ConnectionField,
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
} from '../capabilities.js';

// --- type catalog (§5) — the type picker and the type badge ---
export {
  CATEGORY_GROUPS,
  type BuildTypeRefInput,
  type ResolvedType,
  type ResolveType,
  type TypeCatalog,
  type TypeCategory,
  type TypeDescriptor,
  type TypeParameterDescriptor,
  type TypePickerOption,
  type TypeResolutionContext,
  type TypeResolutionStatus,
} from '../type-catalog.js';

// --- diagnostics (§2.2–§2.5) — rendered per recipient, in the browser ---
export {
  diagnosticTypeRank,
  renderDiagnostic,
  sortDiagnostics,
  type Diagnostic,
  type DiagnosticMessages,
  type DiagnosticParam,
  type DiagnosticSeverity,
  type DiagnosticTarget,
  type EngineId,
  type EnginePropsKind,
  type QuickFix,
  type QuickFixEdit,
} from '../diagnostics.js';

// --- link rules (§7) — the canvas calls the SHARED checker, never a UI-local copy ---
export { checkLink, type LinkCheck, type LinkCheckInput, type LinkCheckReason } from '../links.js';

// --- engineProps (§6) — the inspector validates locally before a round trip ---
export {
  parseEngineProps,
  type EnginePropsResolver,
  type EnginePropsSchemas,
  type ParseEnginePropsResult,
} from '../props.js';

// --- the facet itself (§3) ---
export type { EngineParadigm, EngineStaticFacet } from '../definition.js';

// --- errors (§14.1) — the facet registry rejects with UnknownEngineError (§16.0) ---
export { EngineError, EngineFeatureUnsupportedError, UnknownEngineError } from '../errors.js';
