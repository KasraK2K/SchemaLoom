/**
 * Doc 04 §8.8 — restore, expressed as ordinary write ops.
 *
 * Restore is `opsFromDiff(diffModels(live, snapshot), live)` submitted as one batch, so it
 * goes through the same validation, permission and broadcast path as hand editing instead
 * of being a privileged bulk overwrite.
 */
import type { Id } from '../ids.js';
import type { IrObject, IrObjectType, SchemaModel } from '../model.js';
import type { SchemaDiff } from './types.js';

/**
 * The reason this throws rather than documents.
 *
 * `SchemaDiff.redacted` exists precisely so a restore cannot be computed from a view that
 * is MISSING the objects the viewer may not see. If `live` were an Editor's redacted
 * model, every entity outside their Area would diff as `removed`, and this function would
 * emit deletes for the entire rest of the project — atomically, through the ordinary write
 * path, hard-deleted per C8. There is no safe partial answer and no option to opt out.
 */
export class RedactedDiffError extends Error {
  constructor(side: 'diff' | 'live') {
    super(
      `opsFromDiff refuses a redacted ${side}: a restore computed from a partial view ` +
        `would delete every object the viewer cannot see (doc 04 §8.8).`,
    );
    this.name = 'RedactedDiffError';
  }
}

/**
 * The structural op plan. Deliberately NOT a second copy of the API's `SchemaOperation`
 * zod union: this carries whole IR objects and the API's boundary schemas strip the
 * server-owned fields (§8.3) as they already do for every other write. Same relationship
 * `rows.ts` has to Prisma — schema-model owns a plain shape, the API maps onto it.
 *
 * Unordered. `sortOps` (§8.6 rule 7) is what puts creates before their dependents and
 * deletes after; this function's job is only WHAT, never in what order.
 */
export type RestoreOp =
  | { readonly op: 'create'; readonly type: IrObjectType; readonly object: IrObject }
  | {
      readonly op: 'update';
      readonly type: IrObjectType;
      readonly id: Id;
      readonly object: IrObject;
      readonly expectedVersion: number;
    }
  | {
      readonly op: 'delete';
      readonly type: IrObjectType;
      readonly id: Id;
      readonly expectedVersion: number;
    };

/**
 * `live` is the CURRENT live model. It supplies `expectedVersion` for every update and
 * delete, looked up by id — a snapshot's stored versions are frozen at capture time and
 * stale by definition, so using them would 409 every op, roll the atomic batch back, and
 * make restore permanently impossible. Creates carry no version.
 *
 * THROWS `RedactedDiffError` if `diff.redacted || live.redacted`.
 */
export function opsFromDiff(diff: SchemaDiff, live: SchemaModel): RestoreOp[] {
  if (diff.redacted) throw new RedactedDiffError('diff');
  if (live.redacted) throw new RedactedDiffError('live');

  const expectedVersion = (type: IrObjectType, id: Id): number => {
    const object = live.objects[type][id];
    if (object === undefined) {
      // The diff's `before` side must BE `live`. A mismatch means the caller paired a
      // diff with the wrong model, and guessing a version would 409 or clobber.
      throw new Error(`opsFromDiff: ${type} ${id} is not in the live model`);
    }
    return object.version;
  };

  const ops: RestoreOp[] = [];
  for (const entry of diff.entries) {
    switch (entry.change) {
      case 'added':
        ops.push({ op: 'create', type: entry.objectType, object: entry.after });
        break;
      case 'removed':
        ops.push({
          op: 'delete',
          type: entry.objectType,
          id: entry.before.id,
          expectedVersion: expectedVersion(entry.objectType, entry.before.id),
        });
        break;
      case 'changed':
        ops.push({
          op: 'update',
          type: entry.objectType,
          id: entry.before.id,
          object: entry.after,
          expectedVersion: expectedVersion(entry.objectType, entry.before.id),
        });
        break;
    }
  }
  return ops;
}
