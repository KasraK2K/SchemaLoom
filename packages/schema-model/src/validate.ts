import { pushTo } from './collect.js';
import { MAX_FIELD_DEPTH } from './constants.js';
import type { Id } from './ids.js';
import { createIndex, indexOf, type ModelIndex } from './model-index.js';
import {
  IR_OBJECT_TYPES,
  type IrObject,
  type IrObjectType,
  type SchemaModel,
} from './model.js';
import type { NormalizeName } from './normalize-name.js';

/**
 * STRUCTURAL validation (§11.1): the engine-free invariants, the ones true for MongoDB
 * and PostgreSQL alike.
 *
 * What is deliberately NOT here (§11.2 — `EngineDefinition.validator` owns it): type
 * names and parameters against the type catalogue, identifier length and reserved words,
 * legal `kind` values, `engineProps` against `propsSchemas`, illegal combinations ("a
 * view cannot have a primary key"), and cardinality legality for the paradigm. The split
 * test is: could a reviewer decide this rule without knowing the engine?
 */

export interface ValidationIssue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  objectType: IrObjectType;
  objectId: Id;
  /** Path inside the object, when the issue is about one property. */
  path?: readonly string[];
}

export interface ValidateOptions {
  /** §6.3; default identity. */
  normalizeName?: NormalizeName;
  /** Restrict the REPORT to these objects and their parent scopes — what the write path
   *  passes (§8.6 rule 9). Omitted = whole model. */
  scope?: { type: IrObjectType; id: Id }[];
}

export function validateModel(model: SchemaModel, opts?: ValidateOptions): ValidationIssue[] {
  const ix =
    opts?.normalizeName === undefined
      ? indexOf(model)
      : createIndex(model, { normalizeName: opts.normalizeName });

  const issues: ValidationIssue[] = [];
  const error = (
    code: string,
    objectType: IrObjectType,
    objectId: Id,
    message: string,
    path?: readonly string[],
  ): void => {
    issues.push({ severity: 'error', code, message, objectType, objectId, path });
  };
  const warn = (
    code: string,
    objectType: IrObjectType,
    objectId: Id,
    message: string,
    path?: readonly string[],
  ): void => {
    issues.push({ severity: 'warning', code, message, objectType, objectId, path });
  };

  identity(ix, error);
  danglingAndShape(ix, error, warn);
  fieldTrees(ix, error);
  ordinals(ix, error);
  links(ix, error);
  names(ix, error, warn);

  const scope = opts?.scope;
  if (scope === undefined) return issues;
  // ponytail: scope filters the OUTPUT, not the work. Every check is O(n) over an index
  // the caller already holds, so scoping the scan would save microseconds and cost a
  // second code path per check. If the write path ever profiles hot, scope the groups.
  const wanted = scopeSet(ix, scope);
  return issues.filter((i) => wanted.has(`${i.objectType}:${i.objectId}`));
}

type Report = (
  code: string,
  objectType: IrObjectType,
  objectId: Id,
  message: string,
  path?: readonly string[],
) => void;

/** `ID_COLLISION` / `KEY_MISMATCH` / `ENGINE_PROPS_SHAPE` — the per-object invariants. */
function identity(ix: ModelIndex, error: Report): void {
  const owner = new Map<Id, IrObjectType>();
  for (const type of IR_OBJECT_TYPES) {
    const collection: Record<Id, IrObject> = ix.model.objects[type];
    for (const [key, object] of Object.entries(collection)) {
      if (object.id !== key) {
        error('KEY_MISMATCH', type, key, `${type} keyed as "${key}" carries id "${object.id}"`);
      }
      const seen = owner.get(object.id);
      if (seen === undefined) owner.set(object.id, type);
      else error('ID_COLLISION', type, object.id, `id "${object.id}" is also a ${seen}`);

      const props: unknown = object.engineProps;
      if (typeof props !== 'object' || props === null || Array.isArray(props)) {
        error('ENGINE_PROPS_SHAPE', type, object.id, 'engineProps is not a plain object', [
          'engineProps',
        ]);
      }
    }
  }
}

/** Types whose empty name is a mistake rather than a convention (§11.1) — links and
 *  constraints are legitimately unnamed. */
const NAMED_TYPES = ['namespace', 'entity', 'field', 'customType', 'area'] as const;

function danglingAndShape(ix: ModelIndex, error: Report, warn: Report): void {
  const o = ix.model.objects;
  const missing = (
    type: IrObjectType,
    id: Id,
    what: string,
    ref: Id,
    path: readonly string[],
  ): void => {
    error('DANGLING_REFERENCE', type, id, `${what} "${ref}" does not resolve`, path);
  };

  for (const type of NAMED_TYPES) {
    for (const object of Object.values(o[type]) as IrObject[]) {
      if (object.name === '' && object.restricted !== true) {
        warn('EMPTY_NAME', type, object.id, `${type} has an empty name`, ['name']);
      }
    }
  }

  for (const entity of Object.values(o.entity)) {
    if (o.namespace[entity.namespaceId] === undefined) {
      missing('entity', entity.id, 'namespaceId', entity.namespaceId, ['namespaceId']);
    }
    if (entity.areaId !== null && o.area[entity.areaId] === undefined) {
      missing('entity', entity.id, 'areaId', entity.areaId, ['areaId']);
    }
  }

  for (const customType of Object.values(o.customType)) {
    if (o.namespace[customType.namespaceId] === undefined) {
      missing('customType', customType.id, 'namespaceId', customType.namespaceId, ['namespaceId']);
    }
  }

  for (const field of Object.values(o.field)) {
    if (o.entity[field.entityId] === undefined) {
      missing('field', field.id, 'entityId', field.entityId, ['entityId']);
    }
    if (field.parentFieldId !== null && o.field[field.parentFieldId] === undefined) {
      missing('field', field.id, 'parentFieldId', field.parentFieldId, ['parentFieldId']);
    }
    const customTypeId = field.type.customTypeId;
    if (
      customTypeId !== null &&
      customTypeId !== undefined &&
      o.customType[customTypeId] === undefined
    ) {
      missing('field', field.id, 'type.customTypeId', customTypeId, ['type', 'customTypeId']);
    }
  }

  for (const constraint of Object.values(o.constraint)) {
    if (o.entity[constraint.entityId] === undefined) {
      missing('constraint', constraint.id, 'entityId', constraint.entityId, ['entityId']);
    }
    constraint.fieldIds.forEach((fieldId, i) => {
      if (o.field[fieldId] === undefined) {
        missing('constraint', constraint.id, 'fieldIds', fieldId, ['fieldIds', String(i)]);
      }
    });
  }

  for (const index of Object.values(o.index)) {
    if (o.entity[index.entityId] === undefined) {
      missing('index', index.id, 'entityId', index.entityId, ['entityId']);
    }
    index.columns.forEach((column, i) => {
      if ((column.fieldId === null) === (column.expression === null)) {
        error(
          'INDEX_COLUMN_SOURCE',
          'index',
          index.id,
          'an index column needs exactly one of fieldId / expression',
          ['columns', String(i)],
        );
      }
      if (column.fieldId !== null && o.field[column.fieldId] === undefined) {
        missing('index', index.id, 'columns.fieldId', column.fieldId, [
          'columns',
          String(i),
          'fieldId',
        ]);
      }
    });
  }

  for (const link of Object.values(o.link)) {
    for (const side of ['from', 'to'] as const) {
      const endpoint = link[side];
      if (o.entity[endpoint.entityId] === undefined) {
        missing('link', link.id, `${side}.entityId`, endpoint.entityId, [side, 'entityId']);
      }
      endpoint.fieldIds.forEach((fieldId, i) => {
        if (o.field[fieldId] === undefined) {
          missing('link', link.id, `${side}.fieldIds`, fieldId, [side, 'fieldIds', String(i)]);
        }
      });
    }
  }
}

/** `FIELD_PARENT_CYCLE` / `FIELD_PARENT_ENTITY` / `FIELD_DEPTH_EXCEEDED`. */
function fieldTrees(ix: ModelIndex, error: Report): void {
  const fields = ix.model.objects.field;
  for (const field of Object.values(fields)) {
    const parentId = field.parentFieldId;
    if (parentId !== null) {
      const parent = fields[parentId];
      if (parent !== undefined && parent.entityId !== field.entityId) {
        error(
          'FIELD_PARENT_ENTITY',
          'field',
          field.id,
          `parent field "${parentId}" belongs to entity "${parent.entityId}", ` +
            `not "${field.entityId}"`,
          ['parentFieldId'],
        );
      }
    }

    // Walk to the root. The `seen` set is what makes a cycle terminate instead of
    // spinning, and it is checked before the depth ceiling so a 2-cycle reports as a
    // cycle rather than as "too deep".
    const seen = new Set<Id>([field.id]);
    let depth = 1;
    let cursor = field;
    for (;;) {
      const nextId = cursor.parentFieldId;
      if (nextId === null) break;
      if (seen.has(nextId)) {
        error('FIELD_PARENT_CYCLE', 'field', field.id, 'the parentFieldId chain loops', [
          'parentFieldId',
        ]);
        break;
      }
      const parent = fields[nextId];
      if (parent === undefined) break; // already reported as DANGLING_REFERENCE
      seen.add(nextId);
      cursor = parent;
      depth++;
      if (depth > MAX_FIELD_DEPTH) {
        error(
          'FIELD_DEPTH_EXCEEDED',
          'field',
          field.id,
          `nested deeper than MAX_FIELD_DEPTH (${String(MAX_FIELD_DEPTH)})`,
          ['parentFieldId'],
        );
        break;
      }
    }
  }
}

/** `ORDINAL_COLLISION` — dense `0…n-1`, by construction (§8.6 rule 6, §10.1). */
function ordinals(ix: ModelIndex, error: Report): void {
  const groups = new Map<string, { id: Id; ordinal: number }[]>();
  for (const field of Object.values(ix.model.objects.field)) {
    pushTo(groups, `${field.entityId}|${field.parentFieldId ?? ''}`, field);
  }
  for (const members of groups.values()) {
    checkDense(members, 'field', error, 'sibling fields', ['ordinal']);
  }

  for (const index of Object.values(ix.model.objects.index)) {
    checkDense(
      index.columns.map((c) => ({ id: index.id, ordinal: c.ordinal })),
      'index',
      error,
      'index columns',
      ['columns'],
    );
  }
}

function checkDense(
  members: readonly { id: Id; ordinal: number }[],
  type: IrObjectType,
  error: Report,
  what: string,
  path: readonly string[],
): void {
  const counts = new Map<number, number>();
  for (const m of members) counts.set(m.ordinal, (counts.get(m.ordinal) ?? 0) + 1);

  let duplicated = false;
  for (const m of members) {
    if ((counts.get(m.ordinal) ?? 0) > 1) {
      duplicated = true;
      const message = `${what}: ordinal ${String(m.ordinal)} is used twice`;
      error('ORDINAL_COLLISION', type, m.id, message, path);
    }
  }
  if (duplicated) return;

  const first = members[0];
  if (first !== undefined && !members.every((m) => m.ordinal >= 0 && m.ordinal < members.length)) {
    error('ORDINAL_COLLISION', type, first.id, `${what}: ordinals are not dense 0…n-1`, path);
  }
}

/** `LINK_ARITY` / `LINK_FIELD_OWNER`. */
function links(ix: ModelIndex, error: Report): void {
  const fields = ix.model.objects.field;
  for (const link of Object.values(ix.model.objects.link)) {
    if (link.from.fieldIds.length !== link.to.fieldIds.length) {
      error(
        'LINK_ARITY',
        'link',
        link.id,
        `endpoints pair positionally but hold ${String(link.from.fieldIds.length)} ` +
          `and ${String(link.to.fieldIds.length)} fields`,
      );
    }
    for (const side of ['from', 'to'] as const) {
      const endpoint = link[side];
      endpoint.fieldIds.forEach((fieldId, i) => {
        const field = fields[fieldId];
        if (field !== undefined && field.entityId !== endpoint.entityId) {
          error(
            'LINK_FIELD_OWNER',
            'link',
            link.id,
            `${side} field "${fieldId}" belongs to entity "${field.entityId}", ` +
              `not "${endpoint.entityId}"`,
            [side, 'fieldIds', String(i)],
          );
        }
      });
    }
  }
}

/** `NAME_COLLISION` (error) and `DUPLICATE_LOGICAL_KEY` (warning). */
function names(ix: ModelIndex, error: Report, warn: Report): void {
  const o = ix.model.objects;
  const n = ix.normalizeName;

  const scopes = new Map<string, { type: IrObjectType; id: Id; name: string }[]>();
  const scoped = (type: IrObjectType, scope: string, object: { id: Id; name: string }): void => {
    pushTo(scopes, `${type}|${scope}`, { type, id: object.id, name: object.name });
  };

  for (const namespace of Object.values(o.namespace)) {
    if (namespace.restricted !== true) scoped('namespace', '', namespace);
  }
  for (const area of Object.values(o.area)) {
    if (area.restricted !== true) scoped('area', '', area);
  }
  for (const entity of Object.values(o.entity)) {
    if (entity.restricted !== true) scoped('entity', entity.namespaceId, entity);
  }
  for (const customType of Object.values(o.customType)) {
    if (customType.restricted !== true) scoped('customType', customType.namespaceId, customType);
  }
  for (const field of Object.values(o.field)) {
    if (field.restricted !== true) {
      scoped('field', `${field.entityId}|${field.parentFieldId ?? ''}`, field);
    }
  }
  for (const index of Object.values(o.index)) {
    if (index.restricted !== true) scoped('index', index.entityId, index);
  }
  for (const constraint of Object.values(o.constraint)) {
    if (constraint.restricted !== true) scoped('constraint', constraint.entityId, constraint);
  }

  for (const members of scopes.values()) {
    const seen = new Map<string, Id>();
    for (const member of members) {
      const folded = n(member.name);
      const first = seen.get(folded);
      if (first === undefined) seen.set(folded, member.id);
      else {
        error(
          'NAME_COLLISION',
          member.type,
          member.id,
          `name "${member.name}" collides with "${first}" in the same scope`,
          ['name'],
        );
      }
    }
  }

  for (const type of IR_OBJECT_TYPES) {
    const seen = new Map<string, Id>();
    for (const [id, key] of ix.logicalKeys[type]) {
      const first = seen.get(key);
      if (first === undefined) seen.set(key, id);
      else {
        warn(
          'DUPLICATE_LOGICAL_KEY',
          type,
          id,
          `logical key "${key}" is also produced by "${first}"`,
        );
      }
    }
  }
}

/** The scoped objects plus the parent scopes their issues are reported against. */
function scopeSet(ix: ModelIndex, scope: readonly { type: IrObjectType; id: Id }[]): Set<string> {
  const o = ix.model.objects;
  const out = new Set<string>();
  const add = (type: IrObjectType, id: Id | null | undefined): void => {
    if (id !== null && id !== undefined) out.add(`${type}:${id}`);
  };

  const addEntity = (entityId: Id): void => {
    add('entity', entityId);
    const entity = o.entity[entityId];
    if (entity === undefined) return;
    add('namespace', entity.namespaceId);
    add('area', entity.areaId);
  };

  for (const target of scope) {
    out.add(`${target.type}:${target.id}`);
    switch (target.type) {
      case 'field': {
        const field = o.field[target.id];
        if (field !== undefined) addEntity(field.entityId);
        break;
      }
      case 'constraint': {
        const constraint = o.constraint[target.id];
        if (constraint !== undefined) addEntity(constraint.entityId);
        break;
      }
      case 'index': {
        const index = o.index[target.id];
        if (index !== undefined) addEntity(index.entityId);
        break;
      }
      case 'entity': {
        addEntity(target.id);
        break;
      }
      case 'customType': {
        const customType = o.customType[target.id];
        if (customType !== undefined) add('namespace', customType.namespaceId);
        break;
      }
      case 'link': {
        const link = o.link[target.id];
        if (link !== undefined) {
          addEntity(link.from.entityId);
          addEntity(link.to.entityId);
        }
        break;
      }
      case 'namespace':
      case 'area':
        break;
    }
  }
  return out;
}
