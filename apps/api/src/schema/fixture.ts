import {
  RawSchemaModel,
  redact,
  type RedactedModel,
  type SchemaModel,
  type VisibilityContext,
} from '@schemaloom/schema-model';
import type { Row, Store } from './fake-prisma';

/**
 * Row builders for the fake store, and a permissive `VisibilityContext`.
 *
 * The defaults exist so a test names only the column it is actually about: a version
 * test should read as "this field is at version 3", not as eighteen columns of noise
 * around the one that matters.
 */

export const PROJECT = 'prj_shop';
export const NS = 'ns_public';

const EMPTY_REFS = { entityIds: [], fieldIds: [] };

export const projectRow = (over: Row = {}): Row => ({
  id: PROJECT,
  engineId: 'postgresql',
  engineVersion: '16',
  schemaRevision: 41n,
  permGeneration: 0,
  deletedAt: null,
  ...over,
});

export const namespaceRow = (over: Row = {}): Row => ({
  id: NS,
  projectId: PROJECT,
  name: 'public',
  isDefault: true,
  engineProps: {},
  refs: EMPTY_REFS,
  version: 0,
  ...over,
});

export const areaRow = (id: string, over: Row = {}): Row => ({
  id,
  projectId: PROJECT,
  name: id,
  color: 'indigo',
  position: 0,
  version: 0,
  ...over,
});

export const entityRow = (id: string, over: Row = {}): Row => ({
  id,
  projectId: PROJECT,
  namespaceId: NS,
  areaId: null,
  name: id,
  kind: 'table',
  positionX: 0,
  positionY: 0,
  width: null,
  height: null,
  color: null,
  engineProps: {},
  refs: EMPTY_REFS,
  version: 0,
  ...over,
});

export const fieldRow = (id: string, entityId: string, over: Row = {}): Row => ({
  id,
  projectId: PROJECT,
  entityId,
  parentFieldId: null,
  name: id,
  dataType: 'text',
  customTypeId: null,
  typeArgs: [],
  typeDimensions: 0,
  position: 0,
  isNullable: true,
  isRestricted: false,
  isPii: false,
  isDeprecated: false,
  engineProps: {},
  refs: EMPTY_REFS,
  version: 0,
  ...over,
});

export const indexRow = (id: string, entityId: string, over: Row = {}): Row => ({
  id,
  projectId: PROJECT,
  entityId,
  name: id,
  method: 'btree',
  isUnique: false,
  engineProps: {},
  refs: EMPTY_REFS,
  version: 0,
  ...over,
});

export const indexColumnRow = (indexId: string, fieldId: string, over: Row = {}): Row => ({
  indexId,
  projectId: PROJECT,
  ordinal: 0,
  fieldId,
  expression: null,
  direction: 'asc',
  isInclude: false,
  engineProps: {},
  ...over,
});

export const constraintRow = (id: string, entityId: string, over: Row = {}): Row => ({
  id,
  projectId: PROJECT,
  entityId,
  name: id,
  kind: 'primaryKey',
  expression: null,
  engineProps: {},
  refs: EMPTY_REFS,
  version: 0,
  ...over,
});

export const constraintColumnRow = (constraintId: string, fieldId: string, over: Row = {}): Row => ({
  constraintId,
  projectId: PROJECT,
  ordinal: 0,
  fieldId,
  ...over,
});

export const linkRow = (id: string, source: string, target: string, over: Row = {}): Row => ({
  id,
  projectId: PROJECT,
  name: id,
  kind: 'foreign_key',
  cardinality: 'many_to_one',
  sourceEntityId: source,
  targetEntityId: target,
  engineProps: {},
  refs: EMPTY_REFS,
  version: 0,
  ...over,
});

export const linkEndpointRow = (linkId: string, source: string, target: string, over: Row = {}): Row => ({
  linkId,
  projectId: PROJECT,
  ordinal: 0,
  sourceFieldId: source,
  targetFieldId: target,
  ...over,
});

/** A store with the project row and the default namespace already in it. */
export const baseStore = (over: Partial<Store> = {}): Partial<Store> => ({
  project: [projectRow()],
  namespace: [namespaceRow()],
  ...over,
});

/**
 * Everything visible, nothing restricted — the baseline a test then narrows. Written out
 * rather than derived from a resolver so the specs in this folder never need Redis.
 */
export function fullContext(
  model: SchemaModel,
  over: Partial<VisibilityContext> = {},
): VisibilityContext {
  const entityIds = Object.keys(model.objects.entity);
  return {
    projectId: model.projectId,
    subjectKind: 'user',
    subjectKey: 'u:ana',
    canOpenProject: true,
    visibleEntityIds: new Set(entityIds),
    restrictedOkEntityIds: new Set(entityIds),
    areasWithAtoms: new Set(Object.keys(model.objects.area)),
    restrictedFieldMode: 'mask',
    totalEntityCount: entityIds.length,
    entitiesWithRestrictedFields: new Set(),
    ...over,
  };
}

/** `redact` is the only way to get a `RedactedModel`, so the specs go through it too. */
export const redactFully = (
  model: SchemaModel,
  over: Partial<VisibilityContext> = {},
): RedactedModel => redact(new RawSchemaModel(model), fullContext(model, over));

/**
 * The same context, derived from the STORE rather than the model — which is what a spec
 * that went through `SchemaLoader` needs, because the model it got back is boxed and it
 * cannot read the entity ids out of it. That is the single-path rule working as intended,
 * in a test.
 */
export function storeContext(
  store: Partial<Store>,
  over: Partial<VisibilityContext> = {},
): VisibilityContext {
  const entityIds = (store.entity ?? []).map((e) => String(e.id));
  return {
    projectId: PROJECT,
    subjectKind: 'user',
    subjectKey: 'u:ana',
    canOpenProject: true,
    visibleEntityIds: new Set(entityIds),
    restrictedOkEntityIds: new Set(entityIds),
    areasWithAtoms: new Set((store.area ?? []).map((a) => String(a.id))),
    restrictedFieldMode: 'mask',
    totalEntityCount: entityIds.length,
    entitiesWithRestrictedFields: new Set(
      (store.field ?? []).filter((f) => f.isRestricted === true).map((f) => String(f.entityId)),
    ),
    ...over,
  };
}
