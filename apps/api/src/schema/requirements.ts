import type { PermissionAtom } from '@schemaloom/contracts';
import type { Id, Link, ModelIndex, SchemaModel } from '@schemaloom/schema-model';
import type { ResourceRef } from '../access';
import type { CreateOp, DeleteOp, SchemaOperation, UpdateOp } from './ops';

/**
 * Doc 04 §8.5 — the required permission atoms, derived from the OP, as an explicit table.
 *
 * Revision 1 derived the atom from the shape of the patch and returned ONE resource. Both
 * halves were wrong. `isRestricted` is an ordinary core column, so any `schema:edit`
 * holder could clear it on a salary column and read the value on the next fetch; and one
 * resource cannot express a link, which touches two entities that may sit in different
 * Areas with different grants (edit on A, none on B, create a link A→B).
 *
 * There is no `docs:edit` branch, because `doc` is server-owned (§8.3): documentation is
 * written through the docs endpoint, which checks `docs:edit` itself. That is what keeps
 * a Documenter-only grant meaningful — they hold `docs:edit` and NOT `schema:edit`, so
 * every op in this table is refused for them, and the docs endpoint is the only write
 * surface they have.
 */
export interface OpRequirement {
  readonly atom: PermissionAtom;
  /** The resolver walks entity → area → project, so the MOST SPECIFIC resource is
   *  enough; naming a broader one would silently demand a broader grant. */
  readonly ref: ResourceRef;
}

/**
 * The live model, as this function uses it. Declared as a `Pick` rather than the whole
 * `ModelIndex` because `objects[type][id]` is genuinely all it reads: a real `ModelIndex`
 * satisfies it, and a caller with no other use for thirteen lookup maps on every 400 ms
 * autosave batch can pass `{ model }`.
 *
 * It is the caller's REDACTED model. §8.6 rule 1 has already refused every op whose
 * target is redacted in any way, so anything this function can still reach is fully
 * visible and its `entityId` / `areaId` / endpoints are the true ones.
 */
export type LiveModel = Pick<ModelIndex, 'model'>;

const edit = (ref: ResourceRef): OpRequirement => ({ atom: 'schema:edit', ref });
const entity = (id: Id): ResourceRef => ({ type: 'entity', id });
const area = (id: Id): ResourceRef => ({ type: 'area', id });

interface Scope {
  readonly objects: SchemaModel['objects'];
  readonly project: ResourceRef;
  /**
   * Fail-closed. The visibility gate should make the `undefined` branch unreachable; if
   * an object HAS gone missing between the redaction and here, demanding project-level
   * `schema:edit` is strictly narrower than any area- or entity-scoped grant, so the op
   * is refused rather than waved through on an empty requirement list.
   */
  readonly owner: (id: Id | undefined) => ResourceRef;
}

/** Pure. ALL returned requirements must hold; `assertAll` is all-or-nothing. */
export function requirementsOf(op: SchemaOperation, live: LiveModel): OpRequirement[] {
  const project: ResourceRef = { type: 'project', id: live.model.projectId };
  const scope: Scope = {
    objects: live.model.objects,
    project,
    owner: (id) => (id === undefined ? project : entity(id)),
  };

  switch (op.op) {
    case 'create':
      return onCreate(op, scope);
    case 'update':
      return onUpdate(op, scope);
    case 'delete':
      return onDelete(op, scope);
    case 'move':
      // Re-parenting stays inside one entity (a field's parent is a sibling field), so
      // the owning entity is the only resource a move touches. Its `expectedVersion` is
      // that entity's, which is why one gesture is one conflict check.
      return [edit(scope.owner(scope.objects.field[op.id]?.entityId))];
  }
}

function onCreate(op: CreateOp, scope: Scope): OpRequirement[] {
  switch (op.type) {
    case 'entity':
      return op.object.areaId === null
        ? [edit(scope.project)]
        : [edit(scope.project), edit(area(op.object.areaId))];
    case 'field':
      return op.object.isRestricted
        ? // doc 05 R20: you must be able to SEE a field to classify it as restricted.
          [
            edit(entity(op.object.entityId)),
            { atom: 'field:viewRestricted', ref: entity(op.object.entityId) },
          ]
        : [edit(entity(op.object.entityId))];
    case 'index':
    case 'constraint':
      return [edit(entity(op.object.entityId))];
    case 'link':
      // R19 — BOTH endpoints. One resource cannot express a link whose two entities sit
      // in different Areas with different grants.
      return endpointsOf(op.object).map((id) => edit(entity(id)));
    case 'area':
    case 'namespace':
    case 'customType':
      return [edit(scope.project)];
  }
}

function onUpdate(op: UpdateOp, scope: Scope): OpRequirement[] {
  switch (op.type) {
    case 'entity': {
      if (!('areaId' in op.patch)) return [edit(entity(op.id))];
      // A move between Areas is a GOVERNANCE change: it must be permitted on the Area
      // being LEFT as well as the one being entered, or an editor of B could pull
      // entities out of A and read them.
      const previous = scope.objects.entity[op.id]?.areaId ?? null;
      const next = op.patch.areaId ?? null;
      const refs = [entity(op.id)];
      if (previous !== null) refs.push(area(previous));
      if (next !== null && next !== previous) refs.push(area(next));
      return refs.map(edit);
    }
    case 'field': {
      const ref = scope.owner(scope.objects.field[op.id]?.entityId);
      if (op.patch.isRestricted === true) {
        return [edit(ref), { atom: 'field:viewRestricted', ref }];
      }
      // doc 05 R20 — DE-restriction is an access-control change, not an edit, so it takes
      // `sharing:manage` and NOT `schema:edit`. An editor may hide a column; only someone
      // who can hand out access may un-hide one.
      if (op.patch.isRestricted === false) return [{ atom: 'sharing:manage', ref }];
      return [edit(ref)];
    }
    case 'index':
    case 'constraint': {
      const current =
        op.type === 'index' ? scope.objects.index[op.id] : scope.objects.constraint[op.id];
      const refs = [scope.owner(current?.entityId)];
      const moved = op.patch.entityId;
      if (moved !== undefined && moved !== current?.entityId) refs.push(entity(moved));
      return refs.map(edit);
    }
    case 'link': {
      // Re-pointing an endpoint needs the OLD and the NEW entity of that side, or an
      // editor of C could swing a link off B and onto C without B's consent.
      const current: Link | undefined = scope.objects.link[op.id];
      if (current === undefined) return [edit(scope.project)];
      const ids = new Set<Id>(endpointsOf(current));
      for (const side of [op.patch.from, op.patch.to]) {
        if (side !== undefined) ids.add(side.entityId);
      }
      return [...ids].map((id) => edit(entity(id)));
    }
    case 'area':
      return [edit(area(op.id))];
    case 'namespace':
    case 'customType':
      return [edit(scope.project)];
  }
}

function onDelete(op: DeleteOp, scope: Scope): OpRequirement[] {
  switch (op.type) {
    case 'entity':
      return [edit(entity(op.id))];
    case 'field':
      return [edit(scope.owner(scope.objects.field[op.id]?.entityId))];
    case 'index':
      return [edit(scope.owner(scope.objects.index[op.id]?.entityId))];
    case 'constraint':
      return [edit(scope.owner(scope.objects.constraint[op.id]?.entityId))];
    case 'link': {
      const current: Link | undefined = scope.objects.link[op.id];
      return current === undefined
        ? [edit(scope.project)]
        : endpointsOf(current).map((id) => edit(entity(id)));
    }
    case 'area':
    case 'namespace':
    case 'customType':
      return [edit(scope.project)];
  }
}

/** Both sides, de-duplicated — a self-link must not demand the same grant twice. */
function endpointsOf(link: Pick<Link, 'from' | 'to'>): Id[] {
  return link.from.entityId === link.to.entityId
    ? [link.from.entityId]
    : [link.from.entityId, link.to.entityId];
}
