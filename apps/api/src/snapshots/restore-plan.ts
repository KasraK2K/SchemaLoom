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
  SchemaOperationSchema,
  sortOps,
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
export const FROZEN: Partial<Record<IrObjectType, readonly string[]>> = {
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
function toOperation(
  op: RestoreOp,
  createDefaults = CREATE_DEFAULTS,
  frozenKeys = FROZEN,
): unknown {
  switch (op.op) {
    case 'create':
      return {
        op: 'create',
        type: op.type,
        object: { ...op.object, ...(createDefaults[op.type] ?? {}) },
      };
    case 'update': {
      const frozen = new Set(frozenKeys[op.type] ?? []);
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
 * @param createDefaults R28's fail-closed defaults. SQL import passes `{}`: a column read
 *   from DDL has never been marked Restricted, so there is no earlier decision to preserve.
 * @param frozen R28's frozen keys. A change request passes `{}` for both: its area moves
 *   and restriction changes were reviewed, and `SchemaWriter` still checks each one
 *   (`sharing:manage` to un-restrict, both areas to move) against the merger.
 * @returns `null` when the snapshot already matches live — there is nothing to write, and
 *   an empty batch fails `ops.min(1)` at the boundary.
 */
export function planRestore(
  live: LiveIr,
  snapshot: LiveIr,
  to: SnapshotRef,
  batchId: string,
  label: string,
  createDefaults = CREATE_DEFAULTS,
  frozen = FROZEN,
): SchemaOperationBatch | null {
  const ops = opsFromDiff(restoreDiff(live, snapshot, to), live).map((op) =>
    toOperation(op, createDefaults, frozen),
  );
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

/**
 * SQL import's plan. Unlike a restore it may exceed `MAX_OPS_PER_BATCH` (§8.2: "a DDL
 * import arrives as several batches"), so the ops are dependency-sorted ONCE across the
 * whole import and cut into consecutive batches — every entity is created before any of
 * its fields, whichever batch each lands in. `[]` when there is nothing to write.
 *
 * ponytail: the batches commit one by one, so a failure part-way leaves the earlier ones
 * applied. An import only ever creates (see `mergeImport`), so what is left is a valid,
 * smaller schema; one transaction across batches needs `SchemaWriter` to take a client.
 */
export function planImport(
  live: LiveIr,
  imported: LiveIr,
  batchId: () => string,
  label: string,
  frozen = FROZEN,
): SchemaOperationBatch[] {
  const ops = sortOps(
    opsFromDiff(restoreDiff(live, imported, { kind: 'import', label }), live).map((op) =>
      SchemaOperationSchema.parse(toOperation(op, {}, frozen)),
    ),
  );
  const batches: SchemaOperationBatch[] = [];
  for (let i = 0; i < ops.length; i += MAX_OPS_PER_BATCH) {
    batches.push(
      SchemaOperationBatchSchema.parse({
        batchId: batchId(),
        projectId: live.projectId,
        ops: ops.slice(i, i + MAX_OPS_PER_BATCH),
        label,
      }),
    );
  }
  return batches;
}
