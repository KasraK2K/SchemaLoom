import { addToSet, pushTo, sortBuckets } from './collect.js';
import type { Constraint } from './constraint.js';
import type { Entity } from './entity.js';
import type { Field } from './field.js';
import type { Id } from './ids.js';
import type { Index } from './ir-index.js';
import type { Link } from './link.js';
import { logicalKey } from './logical-key.js';
import { IR_OBJECT_TYPES, type IrObjectType, type SchemaModel } from './model.js';
import { identityNormalizeName, type NormalizeName } from './normalize-name.js';

/**
 * The traversal index (§9). Every lookup core needs that the raw maps do not give
 * cheaply, built in ONE pass, declared honestly: the helpers in `traverse.ts` and
 * `graph.ts` read exactly these structures and nothing hidden.
 *
 * Arrays are pre-sorted — by `ordinal` where the type has one, otherwise by name — then
 * by id, so every ordering in the product is stable and nobody re-sorts per render.
 * Name keys are folded through `normalizeName` (§6.3).
 */
export interface ModelIndex {
  readonly model: SchemaModel;
  readonly normalizeName: NormalizeName;

  readonly fieldsByEntity: ReadonlyMap<Id, readonly Field[]>;
  /** key: `parentFieldId`. Top-level fields are not in here — they are the members of
   *  `fieldsByEntity` whose `parentFieldId` is null. */
  readonly fieldsByParent: ReadonlyMap<Id, readonly Field[]>;
  readonly fieldsByCustomType: ReadonlyMap<Id, readonly Field[]>;
  readonly entitiesByNamespace: ReadonlyMap<Id, readonly Entity[]>;
  readonly entitiesByArea: ReadonlyMap<Id, readonly Entity[]>;
  /** key: `${normalize(namespaceName)}.${normalize(entityName)}`. */
  readonly entityByQualifiedName: ReadonlyMap<string, Id>;
  readonly indexesByEntity: ReadonlyMap<Id, readonly Index[]>;
  readonly constraintsByEntity: ReadonlyMap<Id, readonly Constraint[]>;
  readonly constraintsByField: ReadonlyMap<Id, readonly Constraint[]>;
  /** Both directions: a link appears under both of its entities (once for a loop). */
  readonly linksByEntity: ReadonlyMap<Id, readonly Link[]>;
  readonly linksByField: ReadonlyMap<Id, readonly Link[]>;
  /** entity -> distinct neighbour entities. */
  readonly adjacency: ReadonlyMap<Id, readonly Id[]>;
  readonly logicalKeys: Readonly<Record<IrObjectType, ReadonlyMap<Id, string>>>;
  /** '' when the model has no namespace at all — an invalid model `validateModel`
   *  reports; the index still builds. */
  readonly defaultNamespaceId: Id;

  /** Lazy derivations, computed on first call and cached here (§12.7). Mutable slots on
   *  an otherwise readonly structure — deliberate, and the only mutation in the
   *  package. */
  joinPathCache: Map<string, JoinPathCacheEntry>;
  topoCache: TopologicalOrder | null;
}

/** Declared here rather than in `graph.ts` so `ModelIndex` owns the shape of its own
 *  cache slots without importing from a module that imports it back. */
export interface JoinStep {
  linkId: Id;
  fromEntityId: Id;
  toEntityId: Id;
  /** forward = child -> parent, i.e. along the link's own `from` -> `to`. */
  direction: 'forward' | 'reverse';
  /** Positional endpoint pairs, in traversal order: `[fieldOnFrom, fieldOnTo]`. */
  fieldPairs: [Id, Id][];
}

export interface JoinPath {
  from: Id;
  to: Id;
  steps: JoinStep[];
  cost: number;
}

export type JoinPathCacheEntry = readonly JoinPath[];

export interface TopologicalOrder {
  order: Id[];
  cycles: Id[][];
}

export interface IndexOptions {
  /** The engine's identifier folding (§6.3). Injected, never imported (C10). */
  normalizeName?: NormalizeName;
}

function compareIds(a: { id: Id }, b: { id: Id }): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function byOrdinalThenId(a: { ordinal: number; id: Id }, b: { ordinal: number; id: Id }): number {
  return a.ordinal - b.ordinal || compareIds(a, b);
}

function byNameThenId(n: NormalizeName) {
  return (a: { name: string; id: Id }, b: { name: string; id: Id }): number => {
    const an = n(a.name);
    const bn = n(b.name);
    return an < bn ? -1 : an > bn ? 1 : compareIds(a, b);
  };
}

/**
 * One O(n) pass over the model. Nothing here parses, validates or throws: an index over
 * a broken model is still an index, and `validateModel` is what reports the breakage.
 */
export function createIndex(model: SchemaModel, opts?: IndexOptions): ModelIndex {
  const normalizeName = opts?.normalizeName ?? identityNormalizeName;
  const o = model.objects;

  const fieldsByEntity = new Map<Id, Field[]>();
  const fieldsByParent = new Map<Id, Field[]>();
  const fieldsByCustomType = new Map<Id, Field[]>();
  const entitiesByNamespace = new Map<Id, Entity[]>();
  const entitiesByArea = new Map<Id, Entity[]>();
  const entityByQualifiedName = new Map<string, Id>();
  const indexesByEntity = new Map<Id, Index[]>();
  const constraintsByEntity = new Map<Id, Constraint[]>();
  const constraintsByField = new Map<Id, Constraint[]>();
  const linksByEntity = new Map<Id, Link[]>();
  const linksByField = new Map<Id, Link[]>();
  const adjacencySets = new Map<Id, Set<Id>>();

  let defaultNamespaceId = '';
  for (const ns of Object.values(o.namespace)) {
    if (ns.isDefault && defaultNamespaceId === '') defaultNamespaceId = ns.id;
  }

  const entities = Object.values(o.entity);
  for (const entity of entities) {
    pushTo(entitiesByNamespace, entity.namespaceId, entity);
    if (entity.areaId !== null) pushTo(entitiesByArea, entity.areaId, entity);
    const ns = o.namespace[entity.namespaceId];
    const nsName = ns === undefined ? '' : ns.name;
    entityByQualifiedName.set(`${normalizeName(nsName)}.${normalizeName(entity.name)}`, entity.id);
  }

  for (const field of Object.values(o.field)) {
    pushTo(fieldsByEntity, field.entityId, field);
    if (field.parentFieldId !== null) pushTo(fieldsByParent, field.parentFieldId, field);
    const customTypeId = field.type.customTypeId;
    if (customTypeId !== null && customTypeId !== undefined) {
      pushTo(fieldsByCustomType, customTypeId, field);
    }
  }

  for (const index of Object.values(o.index)) pushTo(indexesByEntity, index.entityId, index);

  for (const constraint of Object.values(o.constraint)) {
    pushTo(constraintsByEntity, constraint.entityId, constraint);
    for (const fieldId of constraint.fieldIds) pushTo(constraintsByField, fieldId, constraint);
  }

  for (const link of Object.values(o.link)) {
    pushTo(linksByEntity, link.from.entityId, link);
    if (link.to.entityId !== link.from.entityId) pushTo(linksByEntity, link.to.entityId, link);
    for (const fieldId of [...link.from.fieldIds, ...link.to.fieldIds]) {
      pushTo(linksByField, fieldId, link);
    }
    addToSet(adjacencySets, link.from.entityId, link.to.entityId);
    addToSet(adjacencySets, link.to.entityId, link.from.entityId);
  }

  const byName = byNameThenId(normalizeName);
  sortBuckets(fieldsByEntity, byOrdinalThenId);
  sortBuckets(fieldsByParent, byOrdinalThenId);
  sortBuckets(fieldsByCustomType, byOrdinalThenId);
  sortBuckets(entitiesByNamespace, byName);
  sortBuckets(entitiesByArea, byName);
  sortBuckets(indexesByEntity, byName);
  sortBuckets(constraintsByEntity, byName);
  sortBuckets(constraintsByField, byName);
  sortBuckets(linksByEntity, byName);
  sortBuckets(linksByField, byName);

  const adjacency = new Map<Id, Id[]>();
  for (const [entityId, set] of adjacencySets) adjacency.set(entityId, [...set].sort());

  const logicalKeys = {} as Record<IrObjectType, Map<Id, string>>;
  for (const type of IR_OBJECT_TYPES) {
    const keys = new Map<Id, string>();
    for (const id of Object.keys(o[type])) keys.set(id, logicalKey(model, type, id, normalizeName));
    logicalKeys[type] = keys;
  }

  return {
    model,
    normalizeName,
    fieldsByEntity,
    fieldsByParent,
    fieldsByCustomType,
    entitiesByNamespace,
    entitiesByArea,
    entityByQualifiedName,
    indexesByEntity,
    constraintsByEntity,
    constraintsByField,
    linksByEntity,
    linksByField,
    adjacency,
    logicalKeys,
    defaultNamespaceId,
    joinPathCache: new Map<string, JoinPathCacheEntry>(),
    topoCache: null,
  };
}

/**
 * Memoized index, IDENTITY normalizer only (§12.2). Models are replaced immutably on
 * every edit, so the cache invalidates itself and there is no invalidation code to get
 * wrong. Callers that need engine name folding build and hold their own with
 * `createIndex(model, { normalizeName })` — see §6.3.
 */
const indexCache = new WeakMap<SchemaModel, ModelIndex>();

export function indexOf(model: SchemaModel): ModelIndex {
  const cached = indexCache.get(model);
  if (cached !== undefined) return cached;
  const built = createIndex(model);
  indexCache.set(model, built);
  return built;
}
