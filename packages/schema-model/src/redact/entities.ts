import type { Entity } from '../entity.js';
import type { Id } from '../ids.js';
import type { SchemaModel } from '../model.js';
import type { RedactionPlan } from './plan.js';
import { applyPropsRule } from './props.js';
import { stubEntity } from './shapes.js';

/**
 * §8.3 entity rows:
 *
 * - visible — kept, its fields filtered by §7.10, the R27 props rule may still blank
 *   `engineProps` (`viewDefinition`, `partitionBy` and friends all leak)
 * - invisible but referenced by a surviving link — a STUB (§8.5)
 * - invisible and referenced by nothing that survives — absent
 *
 * `degradedEntityIds` carries doc 04 §10.2's closing rule: an entity whose constraints
 * or indexes were dropped or blanked by redaction is itself marked, so that "exports
 * respect permissions" does not quietly emit DDL for a table with no primary key — it
 * runs, it creates a table, and the result is subtly wrong rather than obviously refused.
 *
 * Doc 04 spells that mark `restricted: true`. Under RECONCILIATION R-1 that spelling is
 * wrong and dangerous: a restricted Entity IS a stub, so the exporter's rule
 * (`skip if restricted && type === 'entity'`) would DELETE a table the viewer can see.
 * `propsRedacted` is the flag R-1 defines for exactly this — "some properties are hidden
 * from you", still exported — so that is what this uses.
 */
export function redactEntities(
  model: SchemaModel,
  plan: RedactionPlan,
  survivingAreaIds: ReadonlySet<Id>,
  degradedEntityIds: ReadonlySet<Id>,
): Record<Id, Entity> {
  const defaultNamespaceId = plan.defaultNamespaceId;
  const out: Record<Id, Entity> = {};

  for (const entity of Object.values(model.objects.entity)) {
    if (plan.stubEntityIds.has(entity.id)) {
      if (defaultNamespaceId !== null) out[entity.id] = stubEntity(entity, defaultNamespaceId);
      continue;
    }
    if (!plan.visibleEntityIds.has(entity.id)) continue;

    // An area is only dropped when it holds no visible entity and carries no atom, so a
    // visible entity's area normally survives. A raw model with a dangling `areaId` is
    // the exception, and null is the fail-closed answer.
    const areaId =
      entity.areaId !== null && survivingAreaIds.has(entity.areaId) ? entity.areaId : null;

    const kept = applyPropsRule({ ...entity, areaId }, plan);
    out[entity.id] = degradedEntityIds.has(entity.id)
      ? { ...kept, propsRedacted: true }
      : kept;
  }
  return out;
}
