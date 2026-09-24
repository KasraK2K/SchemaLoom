import type { Id } from '../ids.js';
import type { Index } from '../ir-index.js';
import type { SchemaModel } from '../model.js';
import type { RedactionPlan } from './plan.js';
import { applyPropsRule, propsMustDrop, refsNameHidden } from './props.js';
import { badgeIndex, denseColumns } from './shapes.js';

/**
 * §8.3, index rows. Same shape as the constraint rules plus the expression-column half
 * of R27 (L3): `CREATE INDEX … ON employees ((salary * 12)) WHERE salary > 100000`
 * names and characterises a column without referencing any field id, so the body and the
 * partial predicate are dropped, never rewritten.
 *
 * "If no `role: 'key'` column survives, the whole index is absent" — an index that was
 * nothing but expressions has nothing left to badge.
 */
export function redactIndexes(model: SchemaModel, plan: RedactionPlan): Record<Id, Index> {
  const out: Record<Id, Index> = {};
  for (const index of Object.values(model.objects.index)) {
    const redacted = redactIndex(index, plan);
    if (redacted !== null) out[index.id] = redacted;
  }
  return out;
}

function redactIndex(index: Index, plan: RedactionPlan): Index | null {
  if (!plan.visibleEntityIds.has(index.entityId)) return null;

  let masked = false;
  for (const column of index.columns) {
    if (column.fieldId === null) continue;
    const visibility = plan.fieldVis.get(column.fieldId);
    if (visibility === 'masked') masked = true;
    else if (visibility !== 'full') return null; // a hidden column would dangle
  }

  const badgeOnly = masked || refsNameHidden(index, plan);
  if (!badgeOnly && !propsMustDrop(index, plan)) return applyPropsRule(index, plan);

  const columns = index.columns.filter((column) => column.expression === null);
  if (!columns.some((column) => column.role === 'key')) return null;
  if (badgeOnly) return badgeIndex(index, columns);

  // The index's own name is safe — nothing it references is hidden, the engine merely
  // could not prove its expression bodies are. R-1's two flags are independent, so this
  // fully visible object is marked `propsRedacted`, never `restricted`: marking it
  // restricted would make every `if (obj.restricted)` path hide an index the viewer is
  // allowed to see, and the exporter would skip it.
  const next = applyPropsRule({ ...index, columns: denseColumns(columns) }, plan);
  return columns.length === index.columns.length ? next : { ...next, propsRedacted: true };
}
