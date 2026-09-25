/**
 * Doc 04 §7.4 — one matched pair in, its `PropertyChange[]` out.
 *
 * There is no per-object-type comparator. `deepDiff` walks whatever the object actually
 * has and `severityFor` labels the result, so adding a property to an IR schema needs no
 * change here — only a row in §7.4's table if it is not `structural`.
 *
 * §7.6 comes out of this for free: a nested field is an ordinary field, so re-parenting is
 * a `['parentFieldId']` change, and a link endpoint's positional arrays diff by index, so
 * widening a composite FK emits `['from','fieldIds','1']` and `['to','fieldIds','1']`.
 */
import type { IrObject, IrObjectType } from '../model.js';
import { deepDiff } from './deep-diff.js';
import { isDiffedProperty, severityFor } from './severity.js';
import type { PropertyChange } from './types.js';

export function propertyChanges(
  objectType: IrObjectType,
  before: IrObject,
  after: IrObject,
): PropertyChange[] {
  // Spreading gives an indexable plain object without asserting anything away.
  const b: Record<string, unknown> = { ...before };
  const a: Record<string, unknown> = { ...after };

  const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort().filter(isDiffedProperty);

  const out: PropertyChange[] = [];
  for (const key of keys) {
    for (const c of deepDiff(b[key], a[key], [key])) {
      out.push({ ...c, severity: severityFor(objectType, c.path) });
    }
  }
  return out;
}
