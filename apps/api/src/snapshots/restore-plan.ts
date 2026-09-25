import { BadRequestException } from '@nestjs/common';
import {
  diffModels,
  opsFromDiff,
  type IrObjectType,
  type RestoreOp,
  type SchemaDiff,
  type SnapshotRef,
} from '@schemaloom/schema-model';
import {
  MAX_OPS_PER_BATCH,
  SchemaOperationBatchSchema,
  type SchemaOperationBatch,
} from '../schema';
import type { LiveIr } from './live-ir';

/**
 * Doc 04 §8.8 — restore, as ordinary write ops. PURE: a function of its two models and
 * the caller-supplied provenance, with no clock and no I/O, so the same snapshot against
 * the same live model always plans the same batch.
 *
 * Both parameters are `LiveIr`. That is the whole safety argument: a `RedactedModel` does
 * not satisfy the type, so "restore computed from a view that is missing what the viewer
 * cannot see" cannot be written here. `opsFromDiff` throws on the same condition at
 * runtime, which covers a cast.
 */

/**
 * R28 — **restore never writes access-control attributes.** `schema:edit` is one rung
 * below `sharing:manage`, so without this a February snapshot restored in April silently
 * un-restricts a column a manager marked Restricted in March, and re-parents entities with
 * none of §7.11's move preview.
 *
 * On an UPDATE the key is dropped from the patch, so the live row keeps its value. On a
 * CREATE there is no live row to preserve, so the defaults below are fail-closed.
 */
const FROZEN: Partial<Record<IrObjectType, readonly string[]>> = {
  entity: ['areaId'],
  field: ['isRestricted'],
};

const CREATE_DEFAULTS: Partial<Record<IrObjectType, Readonly<Record<string, unknown>>>> = {
  entity: { areaId: null },
  field: { isRestricted: true },
};

/**
 * `SchemaOperationBatchSchema` is what strips the server-owned fields (§8.3) a snapshot
 * object still carries — `version`, `refs`, `doc`, `ordinal`, geometry. Running the plan
 * through the SAME zod boundary a hand edit goes through is what keeps restore from being
 * a privileged bulk overwrite with its own rules.
 */
function toOperation(op: RestoreOp): unknown {
  switch (op.op) {
    case 'create':
      return {
        op: 'create',
        type: op.type,
        object: { ...op.object, ...(CREATE_DEFAULTS[op.type] ?? {}) },
      };
    case 'update': {
      const frozen = new Set(FROZEN[op.type] ?? []);
      const patch = Object.fromEntries(
        Object.entries(op.object).filter(([key]) => !frozen.has(key)),
      );
      return { op: 'update', type: op.type, id: op.id, expectedVersion: op.expectedVersion, patch };
    }
    case 'delete':
      return op;
  }
}

/** The diff restore is computed from: live on the left, so `added` means "the snapshot
 *  has it and live does not" and restoring it is a create. */
export const restoreDiff = (live: LiveIr, snapshot: LiveIr, to: SnapshotRef): SchemaDiff =>
  diffModels(live, snapshot, { from: { kind: 'live' }, to });

/**
 * @returns `null` when the snapshot already matches live — there is nothing to write, and
 *   an empty batch fails `ops.min(1)` at the boundary.
 */
export function planRestore(
  live: LiveIr,
  snapshot: LiveIr,
  to: SnapshotRef,
  batchId: string,
  label: string,
): SchemaOperationBatch | null {
  const ops = opsFromDiff(restoreDiff(live, snapshot, to), live).map(toOperation);
  if (ops.length === 0) return null;
  if (ops.length > MAX_OPS_PER_BATCH) {
    // §8.2's bound is a DoS guard on the request body, and a restore that exceeds it needs
    // the batching the importer has rather than a silently truncated rewrite.
    throw new BadRequestException({
      code: 'restore_too_large',
      ops: ops.length,
      max: MAX_OPS_PER_BATCH,
    });
  }
  return SchemaOperationBatchSchema.parse({ batchId, projectId: live.projectId, ops, label });
}
