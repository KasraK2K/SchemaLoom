import { MAX_FIELD_DEPTH } from './constants.js';
import type { Constraint } from './constraint.js';
import type { Entity } from './entity.js';
import type { Field, FieldNamePath, FieldPath } from './field.js';
import type { Id } from './ids.js';
import type { Index } from './ir-index.js';
import type { ModelIndex } from './model-index.js';
import type { IrObjectMap, IrObjectType, SchemaModel } from './model.js';

/**
 * Lookup, field and badge helpers (§9). Every one of them reads `ModelIndex` and does
 * no scanning of its own, so a 300-entity model costs the same as a 3-entity one.
 *
 * Returned arrays are copies: the index's own arrays are pre-sorted shared state, and a
 * caller that sorted or spliced one in place would corrupt every later lookup.
 */

/** The two constraint kinds core derives badges from (§2.9). Core does not otherwise
 *  branch on `kind`; these two exist because PK and UNIQUE badges are core UI and their
 *  truth must live in exactly one place — the `Constraint`, never a field flag. */
export const CONSTRAINT_KIND_PRIMARY_KEY = 'primaryKey';
export const CONSTRAINT_KIND_UNIQUE = 'unique';

// --- identity / lookup -------------------------------------------------------

export function get<T extends IrObjectType>(
  model: SchemaModel,
  type: T,
  id: Id,
): IrObjectMap[T] | undefined {
  // The one assertion in the package: indexing a generic key gives TypeScript the union
  // of all eight collections, and it cannot see that `type` pins the value type.
  return model.objects[type][id] as IrObjectMap[T] | undefined;
}

export function getEntity(ix: ModelIndex, entityId: Id): Entity | undefined {
  return ix.model.objects.entity[entityId];
}

/** Name order. */
export function entitiesOf(ix: ModelIndex, namespaceId: Id): Entity[] {
  return [...(ix.entitiesByNamespace.get(namespaceId) ?? [])];
}

export function entitiesOfArea(ix: ModelIndex, areaId: Id): Entity[] {
  return [...(ix.entitiesByArea.get(areaId) ?? [])];
}

/**
 * Compares through `ix.normalizeName`, so with the PostgreSQL engine's folder
 * `findEntityByName(ix, 'public', 'Orders')` finds `orders`. This is the lookup the
 * Phase-2 queryValidator resolves parsed SQL identifiers against, which is why it is not
 * exact-match and why the engine does not need a second index.
 */
export function findEntityByName(
  ix: ModelIndex,
  namespace: string,
  name: string,
): Entity | undefined {
  const key = `${ix.normalizeName(namespace)}.${ix.normalizeName(name)}`;
  const id = ix.entityByQualifiedName.get(key);
  return id === undefined ? undefined : ix.model.objects.entity[id];
}

// --- fields ------------------------------------------------------------------

/**
 * Always ordered by `ordinal`.
 *
 * - no options: every field of the entity, all depths, flat;
 * - `parentFieldId`: that sibling group only (`null` = top level);
 * - `recursive`: each group followed by its descendants, depth-first.
 *
 * The recursive walk is bounded by `MAX_FIELD_DEPTH`, so a `parentFieldId` cycle
 * terminates here instead of hanging the caller — `FIELD_PARENT_CYCLE` is what reports
 * it.
 */
export function fieldsOf(
  ix: ModelIndex,
  entityId: Id,
  opts?: { parentFieldId?: Id | null; recursive?: boolean },
): Field[] {
  const all = ix.fieldsByEntity.get(entityId) ?? [];
  const parentFieldId = opts?.parentFieldId;
  const recursive = opts?.recursive === true;

  let group: readonly Field[];
  if (parentFieldId === undefined) {
    group = recursive ? all.filter((f) => f.parentFieldId === null) : all;
  } else if (parentFieldId === null) {
    group = all.filter((f) => f.parentFieldId === null);
  } else {
    group = ix.fieldsByParent.get(parentFieldId) ?? [];
  }
  if (!recursive) return [...group];

  const out: Field[] = [];
  const walk = (fields: readonly Field[], depth: number): void => {
    for (const field of fields) {
      out.push(field);
      if (depth < MAX_FIELD_DEPTH) walk(ix.fieldsByParent.get(field.id) ?? [], depth + 1);
    }
  };
  walk(group, 1);
  return out;
}

/** Root-to-leaf chain, bounded by `MAX_FIELD_DEPTH` + 1 so a cycle cannot hang. Empty
 *  when the field is not in the model. */
function chain(ix: ModelIndex, fieldId: Id): Field[] {
  const fields = ix.model.objects.field;
  const start = fields[fieldId];
  if (start === undefined) return [];
  const out: Field[] = [start];
  let cur = start;
  while (cur.parentFieldId !== null && out.length <= MAX_FIELD_DEPTH) {
    const parent = fields[cur.parentFieldId];
    if (parent === undefined) break;
    out.unshift(parent);
    cur = parent;
  }
  return out;
}

/** A top-level field is depth 1. 0 means "no such field". A cycle reports
 *  `MAX_FIELD_DEPTH + 1`, which is exactly the "too deep" answer. */
export function fieldDepth(ix: ModelIndex, fieldId: Id): number {
  return chain(ix, fieldId).length;
}

/** CANONICAL addressing (§4.1) — ids, stable across every rename. */
export function fieldPath(ix: ModelIndex, fieldId: Id): FieldPath {
  return chain(ix, fieldId).map((f) => f.id);
}

/** DISPLAY ONLY — changes when anyone renames anything. */
export function fieldNamePath(ix: ModelIndex, fieldId: Id): FieldNamePath {
  return chain(ix, fieldId).map((f) => f.name);
}

/** Resolves a display path back to a field, folding names through
 *  `ix.normalizeName`. */
export function resolveNamePath(
  ix: ModelIndex,
  entityId: Id,
  names: FieldNamePath,
): Field | undefined {
  const n = ix.normalizeName;
  let group = fieldsOf(ix, entityId, { parentFieldId: null });
  let found: Field | undefined;
  for (const name of names) {
    const wanted = n(name);
    found = group.find((f) => n(f.name) === wanted);
    if (found === undefined) return undefined;
    group = [...(ix.fieldsByParent.get(found.id) ?? [])];
  }
  return found;
}

// --- derived badges (the single source for PK / FK / UNIQUE) -----------------

export function constraintsOf(ix: ModelIndex, entityId: Id): Constraint[] {
  return [...(ix.constraintsByEntity.get(entityId) ?? [])];
}

export function indexesOf(ix: ModelIndex, entityId: Id): Index[] {
  return [...(ix.indexesByEntity.get(entityId) ?? [])];
}

/** In constraint-column order, which is the order the key is declared in. */
export function primaryKeyFields(ix: ModelIndex, entityId: Id): Field[] {
  const pk = (ix.constraintsByEntity.get(entityId) ?? []).find(
    (c) => c.kind === CONSTRAINT_KIND_PRIMARY_KEY,
  );
  if (pk === undefined) return [];
  const fields = ix.model.objects.field;
  return pk.fieldIds.flatMap((id) => {
    const field = fields[id];
    return field === undefined ? [] : [field];
  });
}

export function isPrimaryKey(ix: ModelIndex, fieldId: Id): boolean {
  return (ix.constraintsByField.get(fieldId) ?? []).some(
    (c) => c.kind === CONSTRAINT_KIND_PRIMARY_KEY,
  );
}

/** A unique constraint, a primary key, or a key column of a unique index. An INCLUDE
 *  column is a payload, not a key, so it does not make the field unique. */
export function isUniqueField(ix: ModelIndex, fieldId: Id): boolean {
  const byConstraint = (ix.constraintsByField.get(fieldId) ?? []).some(
    (c) => c.kind === CONSTRAINT_KIND_UNIQUE || c.kind === CONSTRAINT_KIND_PRIMARY_KEY,
  );
  if (byConstraint) return true;
  const field = ix.model.objects.field[fieldId];
  if (field === undefined) return false;
  return (ix.indexesByEntity.get(field.entityId) ?? []).some(
    (idx) => idx.isUnique && idx.columns.some((c) => c.role === 'key' && c.fieldId === fieldId),
  );
}

/** The REFERENCING side only: a foreign key lives on the child, and the parent's key
 *  column is a primary key, not a foreign one. */
export function isForeignKeyField(ix: ModelIndex, fieldId: Id): boolean {
  return (ix.linksByField.get(fieldId) ?? []).some((l) => l.from.fieldIds.includes(fieldId));
}
