/**
 * The snapshots module's public surface.
 *
 * `live-ir` and `restore-plan` are deliberately NOT here. `LiveIr` is the one unredacted
 * `SchemaModel` in the application, and the claim that a restore can never be computed
 * from a partial view rests on nothing outside this folder being able to name it.
 */
export { SnapshotsModule } from './snapshots.module';
export { SnapshotsController, snapshotContext } from './snapshots.controller';
export {
  SnapshotsService,
  SYNC_IMPORT_MAX_BYTES,
  type CreateSnapshotInput,
  type HistoryDiff,
  type ImportPreview,
  type LiveHistoryDiff,
  type MigrationRequest,
  type MigrationView,
  type ImportOutcome,
  type SnapshotContext,
  type SnapshotSummary,
  type SnapshotView,
} from './snapshots.service';
export { ConfirmedRenamesSchema, CreateSnapshotDto, CreateSnapshotSchema } from './snapshots.dto';
export type { ConfirmedRename } from './import-renames';
export {
  SnapshotEngineMismatchException,
  assertFullProjectView,
  assertSnapshotEngine,
} from './restore-guards';
