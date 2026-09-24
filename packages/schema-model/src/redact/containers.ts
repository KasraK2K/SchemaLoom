import type { Area } from '../area.js';
import type { CustomType } from '../custom-type.js';
import type { Id } from '../ids.js';
import type { SchemaModel } from '../model.js';
import type { Namespace } from '../namespace.js';
import type { RedactionPlan } from './plan.js';
import { applyPropsRule } from './props.js';

/**
 * RECONCILIATION R-2 — a namespace survives only if it holds at least one VISIBLE
 * entity, not merely a surviving stub. A namespace name like `payroll_private` is itself
 * a name worth blanking, which is the thing redaction exists to do; doc 05 §8.3's weaker
 * "stub or full" rule leaked exactly that name, and kept a namespace alive purely to
 * host a stub.
 *
 * The project's DEFAULT namespace is always present, because every stub lands in it and
 * its name (`public`) is the same for every project and visible to anyone who may open
 * one.
 */
export function redactNamespaces(model: SchemaModel, plan: RedactionPlan): Record<Id, Namespace> {
  const keep = new Set<Id>();
  for (const entityId of plan.visibleEntityIds) {
    const entity = model.objects.entity[entityId];
    if (entity !== undefined) keep.add(entity.namespaceId);
  }
  if (plan.defaultNamespaceId !== null) keep.add(plan.defaultNamespaceId);

  const out: Record<Id, Namespace> = {};
  for (const namespace of Object.values(model.objects.namespace)) {
    if (keep.has(namespace.id)) out[namespace.id] = applyPropsRule(namespace, plan);
  }
  return out;
}

/**
 * §8.3 — an area survives if it holds at least one VISIBLE entity, or if the subject
 * holds any atom on it. The second clause matters: SPEC workflow #2 starts with the
 * owner creating an empty "Billing" area and sharing it BEFORE grouping tables into it.
 * Without it the freelancer's first load has no area to draw on, and their
 * create-entity call names an area the client was never told exists.
 *
 * A stub entity never keeps an area alive and never carries an `areaId`.
 */
export function redactAreas(model: SchemaModel, plan: RedactionPlan): Record<Id, Area> {
  const keep = new Set<Id>();
  for (const entityId of plan.visibleEntityIds) {
    const entity = model.objects.entity[entityId];
    if (entity?.areaId != null) keep.add(entity.areaId);
  }

  const out: Record<Id, Area> = {};
  for (const area of Object.values(model.objects.area)) {
    if (keep.has(area.id) || plan.ctx.areasWithAtoms.has(area.id)) {
      out[area.id] = applyPropsRule(area, plan);
    }
  }
  return out;
}

/**
 * §8.3 — custom types are project-scoped, not entity-scoped, and are kept if the subject
 * can see any entity at all, because type NAMES are shared vocabulary. (A composite type
 * whose attributes mirror a hidden entity is a known leak vector, §14 Q7: v1 keeps them
 * and flags it.)
 *
 * A custom type whose namespace did not survive is re-parented to the default namespace
 * rather than left dangling — doc 04 §10.2 rule 4 requires `validateModel` to return no
 * error on a redacted model.
 */
export function redactCustomTypes(
  model: SchemaModel,
  plan: RedactionPlan,
  survivingNamespaceIds: ReadonlySet<Id>,
): Record<Id, CustomType> {
  const out: Record<Id, CustomType> = {};
  if (plan.visibleEntityIds.size === 0) return out;

  for (const customType of Object.values(model.objects.customType)) {
    const namespaceId = survivingNamespaceIds.has(customType.namespaceId)
      ? customType.namespaceId
      : (plan.defaultNamespaceId ?? customType.namespaceId);
    out[customType.id] = applyPropsRule({ ...customType, namespaceId }, plan);
  }
  return out;
}
