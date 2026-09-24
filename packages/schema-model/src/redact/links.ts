import type { Id } from '../ids.js';
import type { Link } from '../link.js';
import type { SchemaModel } from '../model.js';
import type { RedactionPlan } from './plan.js';
import { applyPropsRule, refsNameHidden } from './props.js';
import { badgeLink } from './shapes.js';

/**
 * §8.3 link rows, refined by doc 04 §10.2 rule 4 (which is written against the real
 * `LinkEndpoint` — doc 05's row still mentions `from.role`/`to.role`, which doc 04
 * deleted, so its blanket "clear both sides" was written against a stale shape):
 *
 * - both endpoint entities invisible — absent
 * - either endpoint entity is a STUB, or any endpoint field is HIDDEN — kept so the stub
 *   renders connected, with BOTH sides' `fieldIds` cleared TOGETHER (array index IS the
 *   pairing), `name: ''`, `engineProps: {}`, `restricted: true`
 * - endpoints both visible and some endpoint field MASKED — the masked field object is
 *   still in `objects.field` under its real id, so `fieldIds` are left exactly as they
 *   are and arity is preserved for free. `name` and `engineProps` are blanked anyway:
 *   they hold `fk_orders_employee_salary` and the constraint name (L2)
 * - otherwise full, subject to the R27 props rule
 */
export function redactLinks(model: SchemaModel, plan: RedactionPlan): Record<Id, Link> {
  const out: Record<Id, Link> = {};
  for (const link of Object.values(model.objects.link)) {
    const from = link.from.entityId;
    const to = link.to.entityId;
    if (!plan.survivingEntityIds.has(from) || !plan.survivingEntityIds.has(to)) continue;

    const touchesStub = plan.stubEntityIds.has(from) || plan.stubEntityIds.has(to);

    let masked = false;
    let hidden = false;
    for (const fieldId of [...link.from.fieldIds, ...link.to.fieldIds]) {
      const visibility = plan.fieldVis.get(fieldId);
      if (visibility === 'masked') masked = true;
      else if (visibility !== 'full') hidden = true; // hidden, entity-hidden or dangling
    }

    if (touchesStub || hidden) out[link.id] = badgeLink(link, true);
    else if (masked || refsNameHidden(link, plan)) out[link.id] = badgeLink(link, false);
    else out[link.id] = applyPropsRule(link, plan);
  }
  return out;
}
