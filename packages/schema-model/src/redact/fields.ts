import type { Field } from '../field.js';
import type { Id } from '../ids.js';
import type { SchemaModel } from '../model.js';
import type { RedactionPlan } from './plan.js';
import { applyPropsRule } from './props.js';
import { maskedField } from './shapes.js';

/**
 * §7.10 + L22 — field survival and DENSE ORDINALS.
 *
 * A field on a stub or absent entity is always omitted: a stub entity has no fields.
 *
 * Punch-list ∆15 / doc 05 L22: ordinals are renumbered densely PER SIBLING GROUP —
 * per `(entityId, parentFieldId)`, not per entity, because doc 04 scopes ordinal
 * uniqueness to siblings and renumbering across a whole entity would corrupt every
 * nested field.
 *
 * The gap IS the leak. Fields `0,1,3,4` in hide mode tell the viewer exactly how many
 * hidden columns sit between two visible ones, and where. It is also a correctness bug:
 * `validateModel` reports `ORDINAL_COLLISION` on a gapped group, so an un-renumbered
 * redacted model would log errors on data working as designed.
 */
export function redactFields(model: SchemaModel, plan: RedactionPlan): Record<Id, Field> {
  const groups = new Map<string, Field[]>();
  for (const field of Object.values(model.objects.field)) {
    const visibility = plan.fieldVis.get(field.id);
    if (visibility !== 'full' && visibility !== 'masked') continue;

    const key = `${field.entityId}|${field.parentFieldId ?? ''}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [field]);
    else bucket.push(field);
  }

  const out: Record<Id, Field> = {};
  for (const bucket of groups.values()) {
    // Ties on `ordinal` cannot happen in a valid model; breaking them by id keeps
    // redaction deterministic (G2) on one that is invalid anyway.
    bucket.sort((a, b) => a.ordinal - b.ordinal || (a.id < b.id ? -1 : 1));
    bucket.forEach((field, ordinal) => {
      out[field.id] =
        plan.fieldVis.get(field.id) === 'masked'
          ? maskedField(field, ordinal)
          : applyPropsRule({ ...field, ordinal }, plan);
    });
  }
  return out;
}
