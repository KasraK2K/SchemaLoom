import type { DiagnosticMessages } from '@schemaloom/engine-sdk';

/** Diagnostic codes and their English templates (doc 03 §2.4). No prose rides on the wire. */
export const CODE = {
  propsInvalid: 'sqlite.props-invalid',
  identifierReserved: 'sqlite.identifier-reserved',
  identifierEmpty: 'sqlite.identifier-empty',
  duplicateName: 'sqlite.duplicate-name',
  typeNotStrict: 'sqlite.type-not-strict',
  autoIncrementNotKey: 'sqlite.autoincrement-not-key',
  generatedWithDefault: 'sqlite.generated-with-default',
  constraintMissingExpression: 'sqlite.constraint-missing-expression',
  indexKindUnknown: 'sqlite.index-kind-unknown',
  columnMissing: 'sqlite.column-missing',
  linkInvalid: 'sqlite.link-invalid',
  expressionReferenceStale: 'sqlite.expression-reference-stale',
  /** never emitted for a redacted model (doc 03 §10.3 rule 4) */
  exportOmitted: 'sqlite.export-omitted',
  importStatementFailed: 'sqlite.import-statement-failed',
  /** §11.2 — a step's `reasonCode`, and an `unsupported` entry's two codes */
  migrationDropsData: 'sqlite.migration-drops-data',
  migrationRebuild: 'sqlite.migration-rebuild',
  migrationAffinity: 'sqlite.migration-affinity',
  migrationChange: 'sqlite.migration-change',
  migrationUnsupported: 'sqlite.migration-unsupported',
  /** §12 — worded so a hidden object and a typo read the same (doc 05 P8) */
  queryUnknownRelation: 'sqlite.query-unknown-relation',
  queryUnknownColumn: 'sqlite.query-unknown-column',
  queryInvalid: 'sqlite.query-invalid',
} as const;

export const DIAGNOSTIC_MESSAGES: DiagnosticMessages = {
  [CODE.propsInvalid]: '{message}',
  [CODE.identifierReserved]:
    '“{name}” is an SQLite keyword, so every reference to it has to be double-quoted',
  [CODE.identifierEmpty]: 'This object needs a name',
  [CODE.duplicateName]:
    '“{name}” is already used by another object here — SQLite compares names without case',
  [CODE.typeNotStrict]:
    'A STRICT table only takes INT, INTEGER, REAL, TEXT, BLOB or ANY — this column is {type}',
  [CODE.autoIncrementNotKey]: 'AUTOINCREMENT needs the column to be an INTEGER PRIMARY KEY',
  [CODE.generatedWithDefault]: 'A generated column cannot also have a default',
  [CODE.constraintMissingExpression]: 'This check constraint has no expression',
  [CODE.indexKindUnknown]: 'No such index type as “{kind}”',
  [CODE.columnMissing]: 'This refers to a column that no longer exists',
  [CODE.linkInvalid]: 'This foreign key is not valid here: {reason}',
  [CODE.expressionReferenceStale]:
    'This expression refers to something that has been renamed or removed',
  [CODE.exportOmitted]: 'Not exported: {reason}',
  [CODE.importStatementFailed]: 'This statement could not be imported: {reason}',
  [CODE.migrationDropsData]: 'Permanently deletes {object} and every value stored in it',
  [CODE.migrationRebuild]:
    'SQLite can’t alter this in place, so the table is rebuilt: created anew, copied, swapped in',
  [CODE.migrationAffinity]:
    'Changing {from} to {to} changes how SQLite stores the values, so some may change on copy',
  [CODE.migrationChange]: '{object}: {property} ({change})',
  [CODE.migrationUnsupported]: 'Needs a manual step — {reason}',
  [CODE.queryUnknownRelation]: 'No table or view named “{name}”',
  [CODE.queryUnknownColumn]: 'No column named “{name}” here',
  [CODE.queryInvalid]: '{message}',
};
