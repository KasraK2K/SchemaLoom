/**
 * Minimal valid IR objects for tests. Test-only: deliberately NOT re-exported from
 * `index.ts`, so nothing ships in the bundle.
 *
 * Every builder returns the smallest value its schema accepts, so a test that wants to
 * prove one property matters can override exactly that property and nothing else.
 */
import type { Area } from './area.js';
import type { IrBase } from './base.js';
import type { Constraint } from './constraint.js';
import type { CustomType } from './custom-type.js';
import type { Entity } from './entity.js';
import type { Field } from './field.js';
import type { Id } from './ids.js';
import type { Index } from './ir-index.js';
import type { Link } from './link.js';
import { emptyCollections, type IrCollections, type SchemaModel } from './model.js';
import type { Namespace } from './namespace.js';

export function irBase(id: Id, name = ''): IrBase {
  return { id, name, version: 1, engineProps: {} };
}

export function area(id: Id, name: string, over: Partial<Area> = {}): Area {
  return { ...irBase(id, name), color: 'indigo', ordinal: 0, doc: null, ...over };
}

export function namespace(id: Id, name: string, over: Partial<Namespace> = {}): Namespace {
  return { ...irBase(id, name), isDefault: false, ...over };
}

export function customType(
  id: Id,
  name: string,
  namespaceId: Id,
  over: Partial<CustomType> = {},
): CustomType {
  return { ...irBase(id, name), namespaceId, kind: 'enum', ...over };
}

export function entity(id: Id, name: string, namespaceId: Id, over: Partial<Entity> = {}): Entity {
  return {
    ...irBase(id, name),
    namespaceId,
    kind: 'table',
    areaId: null,
    position: { x: 0, y: 0 },
    color: null,
    doc: null,
    ...over,
  };
}

export function field(id: Id, name: string, entityId: Id, over: Partial<Field> = {}): Field {
  return {
    ...irBase(id, name),
    entityId,
    parentFieldId: null,
    ordinal: 0,
    type: { name: 'text' },
    isNullable: false,
    isRestricted: false,
    isPii: false,
    isDeprecated: false,
    doc: null,
    ...over,
  };
}

export function constraint(
  id: Id,
  name: string,
  entityId: Id,
  over: Partial<Constraint> = {},
): Constraint {
  return { ...irBase(id, name), entityId, kind: 'check', fieldIds: [], ...over };
}

export function index(id: Id, name: string, entityId: Id, over: Partial<Index> = {}): Index {
  return { ...irBase(id, name), entityId, kind: 'btree', isUnique: false, columns: [], ...over };
}

export function link(id: Id, name: string, fromId: Id, toId: Id, over: Partial<Link> = {}): Link {
  return {
    ...irBase(id, name),
    kind: 'foreignKey',
    from: { entityId: fromId, fieldIds: [] },
    to: { entityId: toId, fieldIds: [] },
    cardinality: 'N:1',
    ...over,
  };
}

/** Index a list of objects by id, the shape every collection takes. */
export function byId<T extends { id: Id }>(objects: readonly T[]): Record<Id, T> {
  return Object.fromEntries(objects.map((o) => [o.id, o]));
}

export function model(objects: Partial<IrCollections> = {}): SchemaModel {
  return {
    irVersion: 1,
    projectId: 'prj_1',
    engineId: 'postgresql',
    engineVersion: '16',
    redacted: false,
    objects: { ...emptyCollections(), ...objects },
  };
}
