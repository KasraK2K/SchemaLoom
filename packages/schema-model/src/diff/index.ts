/**
 * The package's diff surface (doc 04 §7, §8.8).
 *
 * `matchType`, `propertyChanges`, `sortPath` and `entryBase` are DELIBERATELY not here:
 * they are the inside of `diffModels`, and an exported matcher is a second matcher waiting
 * to drift from the one the migration generator trusts.
 */
export { deepDiff } from './deep-diff.js';
export { diffModels, isCosmeticOnly } from './diff-models.js';
export { RedactedDiffError, opsFromDiff, type RestoreOp } from './ops-from-diff.js';
export {
  nameSimilarity,
  renameCandidates,
  type EntityRenameCandidate,
  type FieldRenameCandidate,
  type RenameCandidate,
  type RenameCandidateOptions,
} from './rename-candidates.js';
export { destructiveEntries, entriesByEntity, entriesOfType, isEmptyDiff } from './selectors.js';
export type {
  ChangeType,
  DiffCounts,
  DiffEntry,
  DiffEntryOf,
  DiffOptions,
  PinnedRename,
  PropertyChange,
  PropertySeverity,
  SchemaDiff,
  SnapshotRef,
} from './types.js';
