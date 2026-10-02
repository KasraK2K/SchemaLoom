import type { DiagnosticMessages } from '@schemaloom/engine-sdk';

/** Diagnostic codes and their English templates (doc 03 §2.4). No prose rides on the wire. */
export const CODE = {
  propsInvalid: 'mysql.props-invalid',
  identifierTooLong: 'mysql.identifier-too-long',
  identifierReserved: 'mysql.identifier-reserved',
  identifierEmpty: 'mysql.identifier-empty',
  duplicateName: 'mysql.duplicate-name',
  reservedIndexName: 'mysql.reserved-index-name',
  typeUnknown: 'mysql.type-unknown',
  typeNeedsValues: 'mysql.type-needs-values',
  typeNotOnTarget: 'mysql.type-not-on-target',
  autoIncrementCount: 'mysql.auto-increment-count',
  autoIncrementNotInteger: 'mysql.auto-increment-not-integer',
  autoIncrementNotIndexed: 'mysql.auto-increment-not-indexed',
  unsignedNotNumeric: 'mysql.unsigned-not-numeric',
  generatedWithDefault: 'mysql.generated-with-default',
  constraintMissingExpression: 'mysql.constraint-missing-expression',
  indexKindUnknown: 'mysql.index-kind-unknown',
  indexUniqueUnsupported: 'mysql.index-unique-unsupported',
  indexNeedsPrefix: 'mysql.index-needs-prefix',
  indexKeyTooLong: 'mysql.index-key-too-long',
  columnMissing: 'mysql.column-missing',
  linkInvalid: 'mysql.link-invalid',
  linkTypeMismatch: 'mysql.link-type-mismatch',
  expressionReferenceStale: 'mysql.expression-reference-stale',
  /** never emitted for a redacted model (doc 03 §10.3 rule 4) */
  exportOmitted: 'mysql.export-omitted',
  importStatementFailed: 'mysql.import-statement-failed',
  /** §11.2 — a step's `reasonCode`, and an `unsupported` entry's two codes */
  migrationDropsData: 'mysql.migration-drops-data',
  migrationTypeNarrowed: 'mysql.migration-type-narrowed',
  migrationTableCopy: 'mysql.migration-table-copy',
  migrationNotNull: 'mysql.migration-not-null',
  migrationChange: 'mysql.migration-change',
  migrationUnsupported: 'mysql.migration-unsupported',
  /** §12 — worded so a hidden object and a typo read the same (doc 05 P8) */
  queryUnknownRelation: 'mysql.query-unknown-relation',
  queryUnknownColumn: 'mysql.query-unknown-column',
  queryAmbiguousColumn: 'mysql.query-ambiguous-column',
} as const;

export const DIAGNOSTIC_MESSAGES: DiagnosticMessages = {
  [CODE.propsInvalid]: '{message}',
  [CODE.identifierTooLong]: 'MySQL names are at most 64 characters; “{name}” has {length}',
  [CODE.identifierReserved]:
    '“{name}” is a reserved word, so every reference to it has to be quoted with backticks',
  [CODE.identifierEmpty]: 'This object needs a name',
  [CODE.duplicateName]:
    '“{name}” is already used by another object here — SchemaLoom compares MySQL names without case',
  [CODE.reservedIndexName]: '“PRIMARY” is reserved for the primary key',
  [CODE.typeUnknown]: 'No such type as “{type}”',
  [CODE.typeNeedsValues]: 'An {type} column needs at least one value',
  [CODE.typeNotOnTarget]: '{type} is not available on {target}',
  [CODE.autoIncrementCount]: 'A table can have only one AUTO_INCREMENT column',
  [CODE.autoIncrementNotInteger]: 'AUTO_INCREMENT needs an integer column — this one is {type}',
  [CODE.autoIncrementNotIndexed]:
    'An AUTO_INCREMENT column must be the first column of a key (usually the primary key)',
  [CODE.unsignedNotNumeric]: 'UNSIGNED only applies to numeric columns — this one is {type}',
  [CODE.generatedWithDefault]: 'A generated column cannot also have a default',
  [CODE.constraintMissingExpression]: 'This check constraint has no expression',
  [CODE.indexKindUnknown]: 'No such index type as “{kind}”',
  [CODE.indexUniqueUnsupported]: 'A {kind} index cannot be unique',
  [CODE.indexNeedsPrefix]:
    'A {type} column can only be indexed with a prefix length, like {column}(255)',
  [CODE.indexKeyTooLong]:
    'This index key may be up to {bytes} bytes; InnoDB allows 3072 — use a prefix length',
  [CODE.columnMissing]: 'This refers to a column that no longer exists',
  [CODE.linkInvalid]: 'This foreign key is not valid here: {reason}',
  [CODE.linkTypeMismatch]:
    'A foreign key needs columns of the same type and signedness: {from} references {to}',
  [CODE.expressionReferenceStale]:
    'This expression refers to something that has been renamed or removed',
  [CODE.exportOmitted]: 'Not exported: {reason}',
  [CODE.importStatementFailed]: 'This statement could not be imported: {reason}',
  [CODE.migrationDropsData]: 'Permanently deletes {object} and every value stored in it',
  [CODE.migrationTypeNarrowed]:
    'Changing {from} to {to} may truncate, round or reject existing values, and copies the table',
  [CODE.migrationTableCopy]: 'Changing {from} to {to} copies the whole table under a lock',
  [CODE.migrationNotNull]:
    'Making {object} NOT NULL copies the table, and fails if any row holds NULL (strict mode)',
  [CODE.migrationChange]: '{object}: {property} ({change})',
  [CODE.migrationUnsupported]: 'Needs a manual step — {reason}',
  [CODE.queryUnknownRelation]: 'No table or view named “{name}”',
  [CODE.queryUnknownColumn]: 'No column named “{name}” here',
  [CODE.queryAmbiguousColumn]: '“{name}” is a column of more than one table here — qualify it',
};
