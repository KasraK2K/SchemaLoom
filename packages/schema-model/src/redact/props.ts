import type { IrBase } from '../base.js';
import type { RedactionPlan } from './plan.js';

/**
 * Doc 05 R27 — the expression rule, the one rule that closes L3–L6.
 *
 * Doc 04 keeps defaults, generated expressions, CHECK bodies and partial-index
 * predicates in `engineProps`, and index expression bodies in `IndexColumn.expression`.
 * Those strings TEXTUALLY name other objects: `CREATE INDEX ON employees ((salary * 12))`
 * references no field id at all, so no id-reference rule can catch it.
 *
 * `IrBase.refs` is the engine's declaration (`extractReferences`, doc 03 §3.1) of which
 * objects an object's expressions name. The permission layer never parses the string and
 * never tries to rewrite it: it DROPS the whole prop.
 *
 * Two predicates, because the two consequences are not the same consequence:
 *
 * - `refsClean` gates the PROPS. It FAILS CLOSED — absent refs, or refs an engine left
 *   empty, are not clean, so an engine that forgets to populate `refs` for a new props
 *   key ships that key blanked rather than verbatim. (Doc 05 leaves this to a dev-time
 *   canary; the punch list does not, and a canary that only runs in dev is not a control.)
 * - `refsNameHidden` gates the NAME of the objects whose names are DERIVED from other
 *   objects' names — index, constraint, link (`idx_emp_salary`, L2/L3). It is the
 *   positive test: refs are present and actually name something the subject cannot see.
 *   Unverified refs must not blank every index name in a partially-visible project.
 */

function refsPointAtHidden(object: IrBase, plan: RedactionPlan): boolean {
  const refs = object.refs;
  if (refs === undefined) return false;
  for (const entityId of refs.entityIds) {
    if (!plan.visibleEntityIds.has(entityId)) return true;
  }
  for (const fieldId of refs.fieldIds) {
    if (plan.fieldVis.get(fieldId) !== 'full') return true;
  }
  return false;
}

/** True only when the engine DECLARED references and every one of them is fully visible. */
export function refsClean(object: IrBase, plan: RedactionPlan): boolean {
  const refs = object.refs;
  if (refs === undefined) return false;
  if (refs.entityIds.length === 0 && refs.fieldIds.length === 0) return false;
  return !refsPointAtHidden(object, plan);
}

/** True when the engine declared references and at least one is not fully visible. */
export function refsNameHidden(object: IrBase, plan: RedactionPlan): boolean {
  return refsPointAtHidden(object, plan);
}

/** Whether this object's expression-bearing properties must be withheld. */
export function propsMustDrop(object: IrBase, plan: RedactionPlan): boolean {
  return plan.partial && !refsClean(object, plan);
}

/**
 * The props half of R27, for every object type that is NOT one of §8.5's three blanked
 * shapes (those blank `engineProps` as part of their shape and carry `restricted: true`
 * instead).
 *
 * `refs` is SERVER-OWNED (§8.3) and never survives unless it is clean: a dirty `refs`
 * discloses the ID of an object the subject was never told exists, which is a leak in its
 * own right. Keeping a CLEAN `refs` is also what makes redaction idempotent — drop it
 * unconditionally and a second pass would blank props it had just decided were safe.
 */
export function applyPropsRule<T extends IrBase>(object: T, plan: RedactionPlan): T {
  if (refsClean(object, plan)) return object;

  const dropProps = propsMustDrop(object, plan) && Object.keys(object.engineProps).length > 0;
  if (object.refs === undefined && !dropProps) return object;

  const stripped: T = object.refs === undefined ? object : { ...object, refs: undefined };
  return dropProps ? { ...stripped, engineProps: {}, propsRedacted: true } : stripped;
}
