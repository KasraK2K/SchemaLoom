/**
 * The snapshots module's public surface.
 *
 * `live-ir` and `restore-plan` are deliberately NOT here. `LiveIr` is the one unredacted
 * `SchemaModel` in the application, and the claim that a restore can never be computed
 * from a partial view rests on nothing outside this folder being able to name it.
 */
export { SnapshotsModule } from './snapshots.module';
export { SnapshotsController } from './snapshots.controller';
export {
  SnapshotsService,
  type CreateSnapshotInput,
  type SnapshotContext,
  type SnapshotSummary,
  type SnapshotView,
} from './snapshots.service';
export { CreateSnapshotDto, CreateSnapshotSchema } from './snapshots.dto';
export {
  SnapshotEngineMismatchException,
  assertFullProjectView,
  assertSnapshotEngine,
} from './restore-guards';
