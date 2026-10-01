/**
 * Phase 10 §5 — the three-way merge behind change requests.
 *
 * Pure, and in one id space: the caller translates the draft's ids before calling. The
 * result is a MODEL, not ops, so the API turns it into a write exactly as restore does
 * (`planRestore(live, merged)` → `SchemaWriter`), and no second op builder exists.
 *
 * Equality ignores `version` and cosmetic properties (layout, colour): layout is not
 * reviewed, so a draft never moves an existing table in the target (§10 Q5). A new object
 * keeps all of its own properties, position included.
 */
import type { Id } from '../ids.js';
import { IR_OBJECT_TYPES, type IrObject, type IrObjectType, type SchemaModel } from '../model.js';
import { validateModel } from '../validate.js';
import { propertyChanges } from './properties.js';
import { severityFor } from './severity.js';

export interface MergeConflict {
  readonly type: IrObjectType;
  readonly id: Id;
  /** `both_changed`: both sides changed or deleted the object since `base`.
   *  Otherwise a `validateModel` code the merge introduced, e.g. `DANGLING_REFERENCE`
   *  for a field added to a table the other side deleted. */
  readonly reason: string;
}

export interface ThreeWayResult {
  /** `ours` with every non-conflicting change from `theirs`. */
  readonly merged: SchemaModel;
  /** Objects whose merged value came from `theirs`. */
  readonly taken: number;
  readonly conflicts: readonly MergeConflict[];
}

export interface ThreeWayOptions {
  /**
   * `'ours'` (merge): a conflict keeps `ours` and is reported, and the caller refuses to
   * write. `'theirs'` (update from main): a conflict takes `theirs`, and an object that
   * the result leaves dangling is dropped. Both are still reported, as what was reset.
   */
  readonly prefer?: 'ours' | 'theirs';
}

/** Server-owned or never compared: `propertyChanges` already skips id/version/refs. */
function same(type: IrObjectType, a: IrObject | undefined, b: IrObject | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return propertyChanges(type, a, b).every((c) => c.severity === 'cosmetic');
}

/** `theirs` with `ours`' layout kept, for an object both sides have. */
function keepLayout(type: IrObjectType, theirs: IrObject, ours: IrObject): IrObject {
  const cosmetic = (key: string): boolean => severityFor(type, [key]) === 'cosmetic';
  const kept = Object.entries(theirs).filter(([key]) => !cosmetic(key));
  const layout = Object.entries(ours).filter(([key]) => cosmetic(key));
  return Object.fromEntries([...kept, ...layout]) as unknown as IrObject;
}

const without = <T>(record: Record<Id, T>, drop: ReadonlySet<string>): Record<Id, T> =>
  Object.fromEntries(Object.entries(record).filter(([id]) => !drop.has(id)));

const issueKey = (i: { code: string; objectType: string; objectId: string }): string =>
  `${i.code}\u0000${i.objectType}\u0000${i.objectId}`;

/** Ordinals are re-assigned by the write path (field creates omit them), so a collision
 *  between two sides' new columns is not a conflict. */
const IGNORED_ISSUES = new Set(['ORDINAL_COLLISION']);

function errorKeys(model: SchemaModel): Set<string> {
  return new Set(
    validateModel(model)
      .filter((i) => i.severity === 'error' && !IGNORED_ISSUES.has(i.code))
      .map(issueKey),
  );
}

export function threeWay(
  base: SchemaModel,
  ours: SchemaModel,
  theirs: SchemaModel,
  options: ThreeWayOptions = {},
): ThreeWayResult {
  const prefer = options.prefer ?? 'ours';
  const objects = { ...ours.objects } as Record<IrObjectType, Record<Id, IrObject>>;
  const conflicts: MergeConflict[] = [];
  let taken = 0;

  for (const type of IR_OBJECT_TYPES) {
    const b = base.objects[type] as Record<Id, IrObject>;
    const o = ours.objects[type] as Record<Id, IrObject>;
    const t = theirs.objects[type] as Record<Id, IrObject>;
    const out: Record<Id, IrObject> = { ...o };
    const removed = new Set<Id>();
    const ids = [...new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])].sort();

    for (const id of ids) {
      const theirsChanged = !same(type, b[id], t[id]);
      if (!theirsChanged) continue;
      const oursChanged = !same(type, b[id], o[id]);
      if (oursChanged && same(type, o[id], t[id])) continue; // the same edit on both sides
      if (oursChanged) {
        conflicts.push({ type, id, reason: 'both_changed' });
        if (prefer === 'ours') continue;
      }
      const next = t[id];
      const current = o[id];
      if (next === undefined) removed.add(id);
      else out[id] = current === undefined ? next : keepLayout(type, next, current);
      taken++;
    }
    objects[type] = without(out, removed);
  }

  let merged = { ...ours, objects } as SchemaModel;

  // A merge of two valid models can still be invalid: a column added on one side to a
  // table deleted on the other. Only errors neither input already had count.
  const known = new Set([...errorKeys(ours), ...errorKeys(theirs)]);
  for (;;) {
    const fresh = validateModel(merged).filter(
      (i) => i.severity === 'error' && !IGNORED_ISSUES.has(i.code) && !known.has(issueKey(i)),
    );
    if (fresh.length === 0) break;
    for (const i of fresh) {
      conflicts.push({ type: i.objectType, id: i.objectId, reason: i.code });
      known.add(issueKey(i));
    }
    if (prefer === 'ours') break;
    // Update from main: the side being updated loses what no longer fits, which can
    // cascade (a dropped column takes its index with it), hence the loop.
    const next = { ...merged.objects } as Record<IrObjectType, Record<Id, IrObject>>;
    for (const i of fresh) next[i.objectType] = without(next[i.objectType], new Set([i.objectId]));
    merged = { ...merged, objects: next } as SchemaModel;
  }

  return { merged, taken, conflicts };
}
