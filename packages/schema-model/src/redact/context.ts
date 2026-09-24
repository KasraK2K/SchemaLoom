import { MAX_FIELD_DEPTH } from '../constants.js';
import type { Field } from '../field.js';
import type { Id } from '../ids.js';
import type { SchemaModel } from '../model.js';

/**
 * Doc 05 §8.1 — the context `redact` is a pure function of.
 *
 * `RestrictedFieldMode` is spelled out here rather than imported: C10 fixes the
 * dependency as `contracts -> schema-model`, so this package cannot import contracts.
 * The two declarations are structurally identical and TypeScript matches them by shape.
 */
export type RestrictedFieldMode = 'mask' | 'hide';

export interface VisibilityContext {
  readonly projectId: string;
  readonly subjectKind: 'user' | 'share_link';
  readonly subjectKey: string;
  readonly canOpenProject: boolean;
  readonly visibleEntityIds: ReadonlySet<string>;
  readonly restrictedOkEntityIds: ReadonlySet<string>;
  /** Areas where the subject holds anything at all — an area with a live grant and no
   *  entities yet must still be rendered (§8.3, area rule). */
  readonly areasWithAtoms: ReadonlySet<string>;
  readonly restrictedFieldMode: RestrictedFieldMode;
  /** R21' needs both of these and cannot fetch them: `redact` is pure. */
  readonly totalEntityCount: number;
  readonly entitiesWithRestrictedFields: ReadonlySet<string>;
}

/** §7.10. `entity-hidden` is "the entity itself is invisible", which is a different
 *  reason from the field's own restriction and produces a different link rule. */
export type FieldVisibility = 'entity-hidden' | 'full' | 'masked' | 'hidden';

export type FieldVisibilityIndex = ReadonlyMap<Id, FieldVisibility>;

/**
 * R24 — restriction is inherited down the field subtree. A child of a restricted field
 * is at most as visible as its parent. Without this a non-restricted child of a
 * restricted parent resolves to `full`, survives redaction, and carries a
 * `parentFieldId` pointing at a mask stub (a dangling reference) or at nothing at all
 * (an existence disclosure in hide mode).
 *
 * The walk is bounded by `MAX_FIELD_DEPTH` and FAILS CLOSED: a cycle, an over-deep tree
 * or a dangling parent all resolve to "restricted". A corrupt model hides a field; it
 * never reveals one.
 */
function restrictedWithAncestors(fields: Record<Id, Field>, field: Field): boolean {
  if (field.isRestricted) return true;

  let parentId = field.parentFieldId;
  for (let depth = 0; depth < MAX_FIELD_DEPTH; depth += 1) {
    if (parentId === null) return false;
    const parent = fields[parentId];
    if (parent === undefined) return true; // dangling parent: fail closed
    if (parent.isRestricted) return true;
    parentId = parent.parentFieldId;
  }
  return true; // ran out of budget: a cycle or an illegal depth. Fail closed.
}

/** §7.10, verbatim, for one field. */
export function fieldVisibility(
  ctx: VisibilityContext,
  fields: Record<Id, Field>,
  field: Field,
): FieldVisibility {
  if (!ctx.visibleEntityIds.has(field.entityId)) return 'entity-hidden';
  if (ctx.restrictedOkEntityIds.has(field.entityId)) return 'full';
  if (!restrictedWithAncestors(fields, field)) return 'full';
  return ctx.restrictedFieldMode === 'mask' ? 'masked' : 'hidden';
}

/**
 * Every field's visibility, computed once. `redact` reads it a dozen times and the
 * ancestor walk must not be repeated per read.
 *
 * `restrictedOkEntityIds` is per ENTITY, not per subject: the same user can hold
 * `field:viewRestricted` on the Billing area and not on the rest of the project.
 */
export function fieldVisibilityIndex(
  model: SchemaModel,
  ctx: VisibilityContext,
): FieldVisibilityIndex {
  const fields = model.objects.field;
  const out = new Map<Id, FieldVisibility>();
  for (const field of Object.values(fields)) {
    out.set(field.id, fieldVisibility(ctx, fields, field));
  }
  return out;
}
