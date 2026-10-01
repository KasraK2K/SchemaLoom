import { IR_OBJECT_TYPES, type Id, type SchemaModel } from '@schemaloom/schema-model';

/**
 * Phase 10 §2 — object ids are global primary keys, so a draft cannot reuse the main
 * project's. These helpers move a model between the two id spaces.
 *
 * The remap is a deep walk that replaces every string EQUAL to a known id, in values and
 * in record keys. That reaches every reference (`entityId`, `fieldIds[]`, link endpoints,
 * `parentFieldId`, a type's `customTypeId`, ...) without a list of reference paths that a
 * new IR property could silently fall out of. Ids are opaque generated strings, so an
 * exact match is a reference, never a name or an expression.
 */
export type IdMap = Readonly<Record<Id, Id>>;

function walk(value: unknown, map: IdMap): unknown {
  if (typeof value === 'string') return map[value] ?? value;
  if (Array.isArray(value)) return value.map((v) => walk(v, map));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [map[key] ?? key, walk(v, map)]),
    );
  }
  return value;
}

/** `model` with every id in `map` replaced, re-homed in `projectId`. */
export function remapIds(model: SchemaModel, map: IdMap, projectId: string): SchemaModel {
  return {
    ...model,
    projectId,
    objects: walk(model.objects, map) as SchemaModel['objects'],
  };
}

/** A fresh id for every object in `model` that `known` does not already map. */
export function freshIds(model: SchemaModel, known: IdMap, newId: () => string): Record<Id, Id> {
  const out: Record<Id, Id> = {};
  for (const type of IR_OBJECT_TYPES) {
    for (const id of Object.keys(model.objects[type])) {
      if (known[id] === undefined) out[id] = newId();
    }
  }
  return out;
}

export const invertIds = (map: IdMap): Record<Id, Id> =>
  Object.fromEntries(Object.entries(map).map(([from, to]) => [to, from]));
