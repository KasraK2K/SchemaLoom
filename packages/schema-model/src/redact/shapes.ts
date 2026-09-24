import type { Constraint } from '../constraint.js';
import type { Entity } from '../entity.js';
import type { Field } from '../field.js';
import type { Id } from '../ids.js';
import type { Index, IndexColumn } from '../ir-index.js';
import type { Link } from '../link.js';

/**
 * Doc 05 §8.5 — exactly what survives. Each builder writes out a WHOLE object: redaction
 * replaces a value with a CONSTANT, it never removes a required key, which is what keeps
 * a redacted model parseable by the same zod schema and renderable by the same canvas.
 * Because the constant is identical for every redacted object it carries zero
 * information, which is what G1 rests on.
 *
 * `version: 0` is a constant everywhere: a real version is an edit-activity signal.
 *
 * Under RECONCILIATION R-1 the three shapes are told apart by the object's TYPE, not by
 * a `level`: a restricted Entity is a stub, a restricted Field is masked, a restricted
 * Index/Constraint/Link is badge-only. There is no `RestrictionMark`.
 */

/**
 * The entity stub — everything the canvas needs to draw a faded connected box, and
 * nothing else.
 *
 * `kind` is REAL: shape only, it says nothing about content, and the canvas picks a
 * renderer by it. `id` is REAL: links must point somewhere and "Request access to this
 * table" (§7.13) needs a target; a cuid carries no name.
 *
 * `namespaceId` is the project's DEFAULT namespace, NEVER the real one — RECONCILIATION
 * R-2. A namespace name like `payroll_private` is itself a name worth blanking, and the
 * real one would either dangle (the namespace held no visible entity and was dropped) or
 * be kept alive purely to host a stub.
 *
 * `width`/`height` are omitted, not copied: a user-resized card box is a hint about how
 * many columns the table has.
 */
export function stubEntity(entity: Entity, defaultNamespaceId: Id): Entity {
  return {
    id: entity.id,
    name: '',
    version: 0,
    engineProps: {},
    restricted: true,
    namespaceId: defaultNamespaceId,
    kind: entity.kind,
    areaId: null, // a stub never keeps an Area alive (§8.3)
    position: entity.position, // REAL: the diagram must not reflow per viewer
    color: null,
    doc: null,
  };
}

/**
 * The masked field (mask mode only) — the slot, and nothing that describes it.
 *
 * Punch-list ∆4: a masked field keeps ONLY `id`, `entityId`, `parentFieldId` and
 * `ordinal`. SchemaLoom stores no user data — the names and types ARE the content — so
 * keeping `name` and `type` would leave the spec's own workflow-#2 freelancer reading
 * `salary numeric(10,2)` and would make `field:viewRestricted` decorative.
 *
 * `parentFieldId` is REAL so the tree stays walkable (R24). `ordinal` is the slot's
 * position after dense renumbering within its `(entityId, parentFieldId)` sibling group.
 */
export function maskedField(field: Field, ordinal: number): Field {
  return {
    id: field.id,
    name: '',
    version: 0,
    engineProps: {},
    restricted: true,
    entityId: field.entityId,
    parentFieldId: field.parentFieldId,
    ordinal,
    type: { name: '' },
    isNullable: true,
    isRestricted: true,
    isPii: false, // constant: the real flag is a classification signal
    isDeprecated: false,
    doc: null,
  };
}

/**
 * The badge-only constraint: kept so the PK badge still renders, and nothing else
 * (punch-list ∆21). `fieldIds` are unchanged — the masked field objects are still in
 * `objects.field` under their real ids, so nothing dangles and `validateModel` stays
 * quiet. `engineProps` held the CHECK / EXCLUDE body (L4).
 */
export function badgeConstraint(constraint: Constraint): Constraint {
  return {
    ...constraint,
    name: '', // no `chk_emp_salary_positive`
    version: 0,
    engineProps: {},
    refs: undefined,
    restricted: true,
  };
}

/**
 * The badge-only index (∆21). Expression columns are dropped outright — an expression
 * index body characterises a column without referencing its id (L3) — and the survivors
 * are renumbered densely, because `IndexColumn.ordinal` is a dense space too and a gap
 * fires `ORDINAL_COLLISION` on data working as designed.
 */
export function badgeIndex(index: Index, columns: readonly IndexColumn[]): Index {
  return {
    ...index,
    name: '', // no `idx_emp_salary`
    version: 0,
    engineProps: {}, // held the partial WHERE
    refs: undefined,
    columns: denseColumns(columns),
    restricted: true,
  };
}

/** Renumber `columns[].ordinal` to 0…n-1 in their current order. */
export function denseColumns(columns: readonly IndexColumn[]): IndexColumn[] {
  return columns.map((column, ordinal) => ({ ...column, ordinal }));
}

/**
 * A link that survives only so the stub renders connected. `name` held
 * `fk_orders_employee_salary` — two hidden names — and `engineProps` held `onDelete`,
 * `matchFull` and the constraint name (L2).
 *
 * `clearEndpoints` is the doc 04 §10.2 rule-4 distinction, and it is load-bearing:
 * array index IS the pairing on a composite link, so both sides are cleared TOGETHER or
 * neither is. Dropping only the hidden ids would produce `LINK_ARITY` and silently
 * re-pair every subsequent column with the wrong counterpart.
 */
export function badgeLink(link: Link, clearEndpoints: boolean): Link {
  const blanked: Link = {
    ...link,
    name: '',
    version: 0,
    engineProps: {},
    refs: undefined,
    restricted: true,
  };
  if (!clearEndpoints) return blanked;
  return {
    ...blanked,
    from: { entityId: link.from.entityId, fieldIds: [] },
    to: { entityId: link.to.entityId, fieldIds: [] },
  };
}
