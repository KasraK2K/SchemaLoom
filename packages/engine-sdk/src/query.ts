import type { DiagnosticParam, EngineContext, SourceRange } from './diagnostics.js';
import type { Id, RedactedModel } from './ir.js';

/**
 * Doc 03 §12 — the query validator contract (Phase 2).
 *
 * Input is the REDACTED model: the branded type is the enforcement (§2.1). Core never
 * supplies `restrictedProbe` (§12.1, doc 05 L13), so a hidden object and a typo both
 * resolve `unknown`. `validate` never throws: an unparseable query returns
 * `parsed: false` with `parseErrors` and whatever identifiers the parser recovered.
 */
export type IdentifierRole =
  | 'namespace' | 'entity' | 'field' | 'alias' | 'function' | 'custom-type' | 'unknown';

export type ResolutionStatus =
  | 'resolved'     // found in the IR
  | 'alias-local'  // a query-local alias, correctly not in the IR
  | 'unknown'      // no such object
  | 'ambiguous'    // matches more than one entity in scope
  | 'not-visible'  // exists, but the user may not see it (§12.1)
  | 'unchecked';   // inside a construct the validator does not resolve (raw JSON path, CTE body)

export interface IdentifierResolution {
  /** exactly as written in the query, including quoting: "public"."orders" */
  readonly text: string;
  readonly range: SourceRange;
  readonly role: IdentifierRole;
  readonly status: ResolutionStatus;
  /** IR object id when status === 'resolved' */
  readonly targetId: Id | null;
  /** owning entity id, for fields */
  readonly entityId: Id | null;
  /** REQUIRED when status is 'unknown' | 'ambiguous' | 'not-visible'. */
  readonly messageCode: string | null;
  readonly messageParams: Readonly<Record<string, DiagnosticParam>>;
  /** near-miss names for the CodeMirror quick fix, closest first, at most 3 */
  readonly suggestions: readonly string[];
}

export interface QueryValidationInput {
  readonly query: string;
  readonly model: RedactedModel;
  /** Core deliberately does not supply it (§12.1). An engine must tolerate its absence. */
  readonly restrictedProbe?: (qualifiedName: readonly string[]) => 'hidden' | 'absent';
  readonly context: EngineContext;
}

export interface QueryParseError {
  readonly message: string;
  readonly range: SourceRange;
}

export interface QueryValidationResult {
  readonly parsed: boolean;
  readonly parseErrors: readonly QueryParseError[];
  /** every identifier the parser saw, in source order — CodeMirror underlines off this list */
  readonly identifiers: readonly IdentifierResolution[];
  /** deduped, first-appearance order: the canvas glow set (spec 6.3 step 7) */
  readonly touchedEntityIds: readonly string[];
  readonly touchedFieldIds: readonly string[];
  /** references to things the user cannot see */
  readonly hiddenReferences: readonly { readonly text: string; readonly range: SourceRange }[];
  /** 'SELECT', 'UPDATE', … — core warns generically when a query is not read-only */
  readonly statementKinds: readonly string[];
}

export interface QueryValidator {
  validate(input: QueryValidationInput): Promise<QueryValidationResult>;
}
