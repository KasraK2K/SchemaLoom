/**
 * The schema module's public surface.
 *
 * `row-read`, `row-write`, `cascade`, `versions` and `post-images` are deliberately NOT
 * here: they are the Prisma↔IR boundary, and the moment another module can call them the
 * claim that every byte of schema data leaves through `VisibilityFilter` stops being
 * checkable.
 */
export { SchemaModule } from './schema.module';
export { SchemaController } from './schema.controller';
export { SchemaLoader } from './schema-loader.service';
export { SchemaCommits, SchemaWriter, type WriteContext } from './schema-writer.service';
export { GeometryWriter } from './geometry.service';
export {
  toCanvas,
  type CanvasArea,
  type CanvasEntity,
  type CanvasLink,
  type CanvasView,
} from './canvas';
export { requirementsOf, type LiveModel, type OpRequirement } from './requirements';
export { assertOpsVisible } from './visibility-gate';
export { sortOps } from './op-order';
export { SchemaGeometryDto, SchemaOpsDto } from './schema.dto';
export {
  CreateOpSchema,
  DeleteOpSchema,
  GeometryBatchSchema,
  MAX_OPS_PER_BATCH,
  MoveOpSchema,
  SchemaOperationBatchSchema,
  SchemaOperationSchema,
  UpdateOpSchema,
  isTargeted,
  type CreateOp,
  type DeleteOp,
  type GeometryBatch,
  type IrPatch,
  type MoveOp,
  type SchemaOperation,
  type SchemaOperationBatch,
  type SchemaOperationResult,
  type TargetedOp,
  type UpdateOp,
  type VersionConflict,
} from './ops';
