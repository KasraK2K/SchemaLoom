import type { Constraint } from '../constraint.js';
import type { Id } from '../ids.js';
import type { SchemaModel } from '../model.js';
import type { RedactionPlan } from './plan.js';
import { applyPropsRule, refsNameHidden } from './props.js';
import { badgeConstraint } from './shapes.js';

/**
 * §8.3, constraint rows:
 *
 * - on an invisible entity (a stub, or absent) — absent; a stub carries no constraints
 * - referencing a HIDDEN field — absent, because `fieldIds` would dangle
 * - referencing a MASKED field, or whose `refs` name something hidden — kept with
 *   `name: ''`, `engineProps: {}`, `fieldIds` unchanged, `restricted: true`. This is
 *   what keeps the PK badge rendering (∆21)
 * - otherwise full, subject to the R27 props rule
 */
export function redactConstraints(model: SchemaModel, plan: RedactionPlan): Record<Id, Constraint> {
  const out: Record<Id, Constraint> = {};
  for (const constraint of Object.values(model.objects.constraint)) {
    if (!plan.visibleEntityIds.has(constraint.entityId)) continue;

    let masked = false;
    let hidden = false;
    for (const fieldId of constraint.fieldIds) {
      const visibility = plan.fieldVis.get(fieldId);
      if (visibility === 'masked') masked = true;
      else if (visibility !== 'full') hidden = true; // hidden, entity-hidden or dangling
    }
    if (hidden) continue;

    out[constraint.id] =
      masked || refsNameHidden(constraint, plan)
        ? badgeConstraint(constraint)
        : applyPropsRule(constraint, plan);
  }
  return out;
}
