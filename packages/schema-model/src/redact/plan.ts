import type { Id } from '../ids.js';
import type { SchemaModel } from '../model.js';
import {
  fieldVisibilityIndex,
  type FieldVisibilityIndex,
  type VisibilityContext,
} from './context.js';

/**
 * Everything `redact`'s per-object rules need, derived once from `(model, ctx)`.
 *
 * Computing it up front is what makes the per-object rules readable: each one is a
 * handful of set lookups with no ordering hazard between object types.
 */
export interface RedactionPlan {
  readonly ctx: VisibilityContext;
  readonly fieldVis: FieldVisibilityIndex;
  /** Entities the subject may see AND that exist in this model. */
  readonly visibleEntityIds: ReadonlySet<Id>;
  /** Invisible entities kept as a stub because a surviving link needs an endpoint. */
  readonly stubEntityIds: ReadonlySet<Id>;
  /** `visible ∪ stub` — the only entity ids an emitted object may reference. */
  readonly survivingEntityIds: ReadonlySet<Id>;
  /** RECONCILIATION R-2: every stub lands here, never in its real namespace. */
  readonly defaultNamespaceId: Id | null;
  /**
   * True when ANYTHING in this model is invisible to the subject. When it is false there
   * is nothing for an expression to leak, so the R27 props rule is skipped entirely and
   * a full-access viewer's redacted model is the raw model plus `redacted: true`.
   */
  readonly partial: boolean;
}

export function planRedaction(model: SchemaModel, ctx: VisibilityContext): RedactionPlan {
  const o = model.objects;
  const fieldVis = fieldVisibilityIndex(model, ctx);

  const visibleEntityIds = new Set<Id>();
  for (const entity of Object.values(o.entity)) {
    if (ctx.visibleEntityIds.has(entity.id)) visibleEntityIds.add(entity.id);
  }

  let defaultNamespaceId: Id | null = null;
  for (const namespace of Object.values(o.namespace)) {
    if (namespace.isDefault) {
      defaultNamespaceId = namespace.id;
      break;
    }
  }

  // A stub exists only to keep a VISIBLE entity's edge connected (§8.3): an invisible
  // entity nothing surviving points at is absent, not stubbed. A stub needs the default
  // namespace to land in (R-2), so a model without one emits no stubs at all — which
  // then drops the links that would have dangled. Fail closed, and `validateModel` stays
  // error-free either way.
  const stubEntityIds = new Set<Id>();
  if (defaultNamespaceId !== null) {
    for (const link of Object.values(o.link)) {
      const a = link.from.entityId;
      const b = link.to.entityId;
      if (visibleEntityIds.has(a) && !visibleEntityIds.has(b) && o.entity[b] !== undefined) {
        stubEntityIds.add(b);
      }
      if (visibleEntityIds.has(b) && !visibleEntityIds.has(a) && o.entity[a] !== undefined) {
        stubEntityIds.add(a);
      }
    }
  }

  const survivingEntityIds = new Set<Id>([...visibleEntityIds, ...stubEntityIds]);

  let partial = visibleEntityIds.size !== Object.keys(o.entity).length;
  if (!partial) {
    for (const visibility of fieldVis.values()) {
      if (visibility !== 'full') {
        partial = true;
        break;
      }
    }
  }

  return {
    ctx,
    fieldVis,
    visibleEntityIds,
    stubEntityIds,
    survivingEntityIds,
    defaultNamespaceId,
    partial,
  };
}
