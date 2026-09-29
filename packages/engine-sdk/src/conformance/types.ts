import type { EnginePropsKind } from '../diagnostics.js';
import type { IrObject, IrObjectRef, RedactedModel, SchemaModel } from '../ir.js';

/**
 * Doc 03 §17 — the fixtures an engine hands the conformance suite.
 *
 * The suite is the contract every engine passes before it is registered, so the fixtures are
 * the engine's own statement of what it claims to do. A check whose fixture is empty is a
 * check with no teeth, and several checks below assert the fixture is non-empty for exactly
 * that reason.
 */

export interface RoundTripFixture {
  readonly name: string;
  /** an `importFormats` id */
  readonly format: string;
  readonly source: string;
  /** statement kinds the fixture expects to be reported non-'applied'; asserted exactly, so a
   *  regression that silently starts dropping CREATE TRIGGER fails here */
  readonly expectNotApplied?: readonly string[];
}

export interface QueryFixture {
  readonly name: string;
  readonly query: string;
  readonly expect: {
    readonly touchedEntityNames: readonly string[];
    readonly unknownIdentifiers: readonly string[];
    readonly parsed: boolean;
  };
}

export interface MigrationFixture {
  readonly name: string;
  readonly before: SchemaModel;
  readonly after: SchemaModel;
  readonly expectDestructive: boolean;
  readonly expectLossy: boolean;
}

/** A props value that MUST be rejected by the engine's `propsSchemas`. */
export interface InvalidPropsFixture {
  readonly kind: EnginePropsKind;
  readonly subKind: string | null;
  readonly value: unknown;
}

/** An object whose `engineProps` carry an expression, paired with the ids that expression
 *  references. Drives `references/superset`. */
export interface ExpressionReferenceFixture {
  readonly object: IrObject;
  readonly subKind: string | null;
  readonly expectReferences: readonly IrObjectRef[];
}

export interface ConformanceFixtures {
  /** A hand-built model exercising every capability the engine claims to support; the
   *  validator must return zero errors on it. */
  readonly referenceModel: SchemaModel;
  readonly roundTrip: readonly RoundTripFixture[];
  readonly queries: readonly QueryFixture[];
  readonly migrations: readonly MigrationFixture[];
  readonly invalidProps: readonly InvalidPropsFixture[];
  /**
   * A redacted model exercising every redaction shape doc 04 §10.2 produces: a stub entity, a
   * visible link into it (both sides' `fieldIds` cleared together), a masked field with its
   * ordinal renumbered densely, an index or constraint kept as a badge-only shell, and an
   * object marked `propsRedacted`. **There is no ordinal gap** — rule 3 renumbers densely,
   * because a gap is itself the disclosure.
   *
   * Typed `RedactedModel`, whose brand only `redact` can mint: a fixture cannot be a
   * hand-written imitation of redaction, which would test the imitation and not the engine.
   */
  readonly redactedModel: RedactedModel;
  /**
   * How the suite turns a model IT built — an importer's output — into the `RedactedModel`
   * the exporter requires. Engines pass `redact` with a fully permissive `VisibilityContext`.
   *
   * A FUNCTION rather than a second model, and required rather than optional, for one
   * reason: `roundtrip/ddl-ir-ddl` has to export the IR that came out of `import()`, and the
   * only alternative is the suite assembling a branded value itself. That would be a second
   * way to mint a `RedactedModel` — the exact thing doc 05 §8.6's single-path rule exists to
   * prevent — living in the package every engine imports. Handing the real `redact` in keeps
   * the brand's guarantee literally true: nothing but `redact` ever produces one.
   *
   * `@schemaloom/schema-model` is not imported here to provide a default, because §2.1 keeps
   * this package's coupling to that one down to `ir.ts`.
   */
  readonly redactForExport: (model: SchemaModel) => RedactedModel;
  readonly expressionReferences: readonly ExpressionReferenceFixture[];
  /** path to the package's "/static" entry, for the bundle-size check; omit to skip it */
  readonly staticEntry?: string;
}

/**
 * Doc 03 §17's list, in doc order. Doc 01 once claimed "six named assertions"; §17 owns the
 * real list and this is it, with two deliberate departures:
 *
 *  - `capabilities/services-match-features` is ADDED. §4.1 and `define-capabilities.ts` both
 *    say the conformance suite owns it — `defineCapabilities` never sees the services, so
 *    nothing else can check that `features.migrations === (migrationGenerator !== undefined)`.
 *    Without it an engine advertises a feature it has not implemented. `aiProfile` is NOT in
 *    it: it has no feature atom, by design.
 *  - there is NO `introspector` check, and none on `features.introspection`: doc 03 §3 cut
 *    the introspector and the atom (punch-list ∆10).
 */
export type ConformanceCheckId =
  | 'identity/id-is-slug'
  | 'identity/version-is-semver'
  | 'capabilities/schema-valid'
  | 'capabilities/features-total'
  | 'capabilities/internally-consistent'
  | 'capabilities/services-match-features'
  | 'terminology/covers-all-kinds'
  | 'types/resolve-format-roundtrip'
  | 'types/aliases-resolve'
  | 'types/unknown-is-total'
  | 'types/picker-includes-custom-types'
  | 'props/schemas-are-strict'
  | 'props/accept-importer-output'
  | 'props/accept-exporter-roundtrip'
  | 'props/reject-invalid'
  | 'props/rollback-is-read-only'
  | 'props/previous-major-migrates'
  | 'links/descriptors-consistent'
  | 'links/tolerates-redacted'
  | 'references/superset'
  | 'import/accounts-for-every-statement'
  | 'import/reasons-present'
  | 'import/never-throws'
  | 'import/deterministic'
  | 'export/deterministic'
  | 'export/order-independent'
  | 'export/phases-ordered'
  | 'export/comments-from-docs'
  | 'export/skips-restricted'
  | 'export/redaction-is-announced'
  | 'roundtrip/ddl-ir-ddl'
  | 'roundtrip/idempotent'
  | 'validator/deterministic'
  | 'validator/sorted'
  | 'validator/clean-on-reference-ir'
  | 'validator/quickfix-resolves'
  | 'validator/expression-reference-stale'
  | 'migration/empty-diff-no-steps'
  | 'migration/drops-are-destructive'
  | 'migration/accounts-for-every-change'
  | 'migration/steps-ordered'
  | 'diff/annotate-is-pure'
  | 'diff/annotate-never-raises-severity'
  | 'query/fixtures-resolve'
  | 'query/unknown-has-range'
  | 'query/never-throws'
  | 'ai/serialize-deterministic'
  | 'ai/serialize-respects-budget'
  | 'ai/serialize-omits-restricted'
  | 'ai/serialize-escapes-docs'
  | 'ai/parse-output-tolerant'
  | 'static/bundle-size';

export const CONFORMANCE_CHECKS: readonly ConformanceCheckId[] = [
  'identity/id-is-slug',
  'identity/version-is-semver',
  'capabilities/schema-valid',
  'capabilities/features-total',
  'capabilities/internally-consistent',
  'capabilities/services-match-features',
  'terminology/covers-all-kinds',
  'types/resolve-format-roundtrip',
  'types/aliases-resolve',
  'types/unknown-is-total',
  'types/picker-includes-custom-types',
  'props/schemas-are-strict',
  'props/accept-importer-output',
  'props/accept-exporter-roundtrip',
  'props/reject-invalid',
  'props/rollback-is-read-only',
  'props/previous-major-migrates',
  'links/descriptors-consistent',
  'links/tolerates-redacted',
  'references/superset',
  'import/accounts-for-every-statement',
  'import/reasons-present',
  'import/never-throws',
  'import/deterministic',
  'export/deterministic',
  'export/order-independent',
  'export/phases-ordered',
  'export/comments-from-docs',
  'export/skips-restricted',
  'export/redaction-is-announced',
  'roundtrip/ddl-ir-ddl',
  'roundtrip/idempotent',
  'validator/deterministic',
  'validator/sorted',
  'validator/clean-on-reference-ir',
  'validator/quickfix-resolves',
  'validator/expression-reference-stale',
  'migration/empty-diff-no-steps',
  'migration/drops-are-destructive',
  'migration/accounts-for-every-change',
  'migration/steps-ordered',
  'diff/annotate-is-pure',
  'diff/annotate-never-raises-severity',
  'query/fixtures-resolve',
  'query/unknown-has-range',
  'query/never-throws',
  'ai/serialize-deterministic',
  'ai/serialize-respects-budget',
  'ai/serialize-omits-restricted',
  'ai/serialize-escapes-docs',
  'ai/parse-output-tolerant',
  'static/bundle-size',
];
