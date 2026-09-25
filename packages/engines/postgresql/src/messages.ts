import type { DiagnosticMessages } from '@schemaloom/engine-sdk';

/**
 * The codes the validator emits, and their English templates (doc 03 §2.4).
 *
 * A `Diagnostic` carries NO prose: `{ code, params, target }` is the wire form, and the
 * sentence is rendered per recipient by `renderDiagnostic`, because a pre-rendered
 * sentence naming `employees.salary` cannot be filtered at the permission boundary.
 * These templates are the catalog that renderer reads.
 */
export const CODE = {
  propsInvalid: 'postgresql.props-invalid',
  identifierTooLong: 'postgresql.identifier-too-long',
  identifierReserved: 'postgresql.identifier-reserved',
  identifierEmpty: 'postgresql.identifier-empty',
  duplicateName: 'postgresql.duplicate-name',
  typeUnknown: 'postgresql.type-unknown',
  customTypeDangling: 'postgresql.custom-type-dangling',
  identityNonInteger: 'postgresql.identity-non-integer',
  identityWithDefault: 'postgresql.identity-with-default',
  generatedWithDefault: 'postgresql.generated-with-default',
  generatedReferencesGenerated: 'postgresql.generated-references-generated',
  constraintMissingExpression: 'postgresql.constraint-missing-expression',
  enumNoLabels: 'postgresql.enum-no-labels',
  indexKindUnknown: 'postgresql.index-kind-unknown',
  indexUniqueUnsupported: 'postgresql.index-unique-unsupported',
  indexIncludeUnsupported: 'postgresql.index-include-unsupported',
  columnMissing: 'postgresql.column-missing',
  linkInvalid: 'postgresql.link-invalid',
  expressionReferenceStale: 'postgresql.expression-reference-stale',
  /** §10 — an object the exporter could not render. NEVER emitted for a redacted model:
   *  §10.3 rule 4 is explicit that a list of per-object notices is a count with extra steps,
   *  and a count over hidden objects is itself the leak. */
  exportOmitted: 'postgresql.export-omitted',
  /** §9 — a statement the importer could not apply, targeted at the PROJECT with a `range`,
   *  because there is no IR object to point at. */
  importStatementFailed: 'postgresql.import-statement-failed',
} as const;

export const DIAGNOSTIC_MESSAGES: DiagnosticMessages = {
  [CODE.propsInvalid]: '{message}',
  [CODE.identifierTooLong]:
    'PostgreSQL truncates identifiers to 63 bytes — “{name}” is {bytes} and will be cut to “{truncated}”',
  [CODE.identifierReserved]:
    '“{name}” is a reserved word, so every reference to it has to be quoted',
  [CODE.identifierEmpty]: 'This object needs a name',
  [CODE.duplicateName]:
    '“{name}” is already used by another object here — PostgreSQL folds unquoted names to lower case',
  [CODE.typeUnknown]: 'No such type as “{type}”',
  [CODE.customTypeDangling]: 'The type this column uses no longer exists',
  [CODE.identityNonInteger]:
    'An identity column must be smallint, integer or bigint — this one is {type}',
  [CODE.identityWithDefault]: 'An identity column cannot also have a default',
  [CODE.generatedWithDefault]: 'A generated column cannot also have a default',
  [CODE.generatedReferencesGenerated]:
    'A generated column cannot be defined in terms of another generated column',
  [CODE.constraintMissingExpression]: 'This {kind} constraint has no expression',
  [CODE.enumNoLabels]: 'An enum needs at least one label',
  [CODE.indexKindUnknown]: 'No such index method as “{kind}”',
  [CODE.indexUniqueUnsupported]: 'A {kind} index cannot be unique',
  [CODE.indexIncludeUnsupported]: 'A {kind} index cannot carry INCLUDE columns',
  [CODE.columnMissing]: 'This references a column that no longer exists',
  [CODE.linkInvalid]: 'These endpoints are not a valid foreign key ({reason})',
  [CODE.expressionReferenceStale]:
    'An expression here names {count} object(s) that no longer exist',
  [CODE.exportOmitted]: 'This is not in the exported script — {reason}',
  [CODE.importStatementFailed]: 'This statement could not be applied — {reason}',
};
