import {
  IR_OBJECT_TYPES,
  type Id,
  type IrObjectRef,
  type IrObjectType,
  type TypeRef,
} from './ir.js';
import { formatMessage, type TerminologyBundle } from './terminology.js';

/** lowercase slug: 'postgresql', 'mongodb', 'neo4j' */
export type EngineId = string;

/**
 * `Area` is the one IR object with no `engineProps` (doc 04 §2.11), so it is excluded.
 * `'indexColumn'` is added because `index_columns` has its own `engine_props` column — it is
 * not an IR *object*, but it is the one nested structure carrying a props bag, and a bag with
 * no schema owner is the untyped-JSONB hole §6 exists to close. There is deliberately no
 * `'project'` member.
 */
export type EnginePropsKind = Exclude<IrObjectType, 'area'> | 'indexColumn';

/**
 * Offsets are UTF-16 code-unit offsets into the source string — exactly what CodeMirror 6
 * wants for a decoration range. `line`/`column` are 1-based and derived; they are carried so
 * the API can render an error message without shipping the source back.
 */
export interface SourceRange {
  /** inclusive */
  readonly start: number;
  /** exclusive */
  readonly end: number;
  readonly line: number;
  readonly column: number;
}

/**
 * Everything an engine is allowed to know about the project it is working on. Deliberately
 * tiny: no user, no permissions, no database handles. Redaction has already happened before
 * any IR reaches an engine.
 */
export interface EngineContext {
  readonly projectId: Id;
  /** The TARGET DATABASE version, e.g. '16' for PostgreSQL 16 — not the plugin version (§15).
   *  The engine needs it to emit version-correct DDL; nothing in the SDK branches on it. */
  readonly serverVersion: string | null;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface DiagnosticTarget {
  /** 'project' is for diagnostics with no IR object: an unparseable import statement, a
   *  whole-source failure. Its `id` is then the project id and `range` carries the location. */
  readonly type: IrObjectType | 'project';
  readonly id: Id;
  /** path inside `engineProps`, when the problem is one specific property */
  readonly propPath?: readonly string[];
}

/** A substitution value. An `IrObjectRef` is resolved to a name by CORE, per recipient, AFTER
 *  redaction — which is how a name never crosses a permission boundary. */
export type DiagnosticParam = string | number | IrObjectRef;

/**
 * A diagnostic carries NO prose (§2.3). The validator runs server-side over the unredacted
 * model and its results are cached per project and broadcast to every socket in the room; a
 * pre-rendered English sentence cannot be filtered, so `{ code, params, target }` IS the wire
 * form and the sentence is rendered per recipient by `renderDiagnostic`. This is the L27 leak
 * control.
 */
export interface Diagnostic {
  /** '<engineId>.<kebab-slug>' — stable, greppable, and the key into the engine's message
   *  catalog (§2.4) */
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly params: Readonly<Record<string, DiagnosticParam>>;
  readonly target: DiagnosticTarget;
  /** present only when the diagnostic came from parsing text (import, query validation) */
  readonly range?: SourceRange;
  readonly quickFix?: QuickFix;
}

export interface QuickFix {
  /** message id in the engine's catalog, rendered the same way as `code` */
  readonly labelCode: string;
  readonly labelParams: Readonly<Record<string, DiagnosticParam>>;
  /** The target object's `version` (C7) when the diagnostic was produced. Diagnostics are
   *  cached, so this is not optional: a fix clicked minutes later 409s instead of clobbering. */
  readonly targetVersion: number;
  readonly edit: QuickFixEdit;
}

/**
 * Deliberately narrow and serializable. A quick fix crosses the wire as JSON and is applied by
 * the normal core object-update endpoint, which re-runs permissions, the version check (C7)
 * and props validation. Engines cannot smuggle arbitrary mutations through a diagnostic.
 */
export type QuickFixEdit =
  | { readonly op: 'setName'; readonly value: string }
  | { readonly op: 'setType'; readonly value: TypeRef }
  | { readonly op: 'setEngineProp'; readonly path: readonly string[]; readonly value: unknown }
  | { readonly op: 'unsetEngineProp'; readonly path: readonly string[] }
  /** routed to the object DELETE route, not the update route. Never valid for a 'project'
   *  target: the type forbids it. */
  | { readonly op: 'deleteObject'; readonly targetType: IrObjectType };

/** Diagnostic-code -> template, on the static facet so the browser renders without a round
 *  trip. `{name}` slots filled from `params`. One sentence, no trailing period. */
export type DiagnosticMessages = Readonly<Record<string, string>>;

function isIrObjectRef(value: DiagnosticParam): value is IrObjectRef {
  return typeof value === 'object';
}

/**
 * Core's only renderer. `resolveRef` is supplied by core and IS the redaction boundary: it
 * returns a display name for a ref the subject may see, and `null` for one it may not — which
 * renders as the core term for a restricted object. An unknown `code` renders as the code
 * itself, so a missing template is visible but never a crash.
 */
export function renderDiagnostic(
  messages: DiagnosticMessages,
  bundle: TerminologyBundle,
  diagnostic: Diagnostic | QuickFix,
  resolveRef: (ref: IrObjectRef) => string | null,
): string {
  const isDiagnostic = 'code' in diagnostic;
  const code = isDiagnostic ? diagnostic.code : diagnostic.labelCode;
  const params = isDiagnostic ? diagnostic.params : diagnostic.labelParams;
  const template = messages[code];
  if (template === undefined) return code;
  return template.replace(/\{([^}]+)\}/g, (whole: string, key: string) => {
    const value = params[key];
    if (value === undefined) return whole;
    if (!isIrObjectRef(value)) return String(value);
    return resolveRef(value) ?? formatMessage(bundle, 'diag.restrictedObject', 'entity');
  });
}

/** `IR_OBJECT_TYPES` is the dependency order and the single source of rank; 'project' sorts
 *  before all of it. No second ordering table. */
export function diagnosticTypeRank(type: DiagnosticTarget['type']): number {
  return type === 'project' ? -1 : IR_OBJECT_TYPES.indexOf(type);
}

/** Byte comparison, never `localeCompare`, whose result depends on the server's ICU data. */
function byteCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The §2.5 ordering contract, in full: `diagnosticTypeRank(target.type)`, `target.id`, `code`,
 * `(target.propPath ?? []).join('.')`, `range?.start ?? -1`. This is what makes "the validator
 * is deterministic" testable and what keeps cached diagnostic payloads diff-stable.
 *
 * Any function in this SDK returning `readonly Diagnostic[]` returns them through this.
 */
export function sortDiagnostics(input: readonly Diagnostic[]): readonly Diagnostic[] {
  return [...input].sort(
    (a, b) =>
      diagnosticTypeRank(a.target.type) - diagnosticTypeRank(b.target.type) ||
      byteCompare(a.target.id, b.target.id) ||
      byteCompare(a.code, b.code) ||
      byteCompare((a.target.propPath ?? []).join('.'), (b.target.propPath ?? []).join('.')) ||
      (a.range?.start ?? -1) - (b.range?.start ?? -1),
  );
}
