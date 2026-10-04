import type {
  Constraint,
  CustomType,
  DocRef,
  EngineProps,
  Entity,
  Field,
  Index,
  IndexColumn,
  Link,
  Namespace,
  ObjectRefs,
  SchemaModel,
  TypeRef,
} from '@schemaloom/engine-sdk';
import {
  RawSchemaModel,
  redact,
  type RedactedModel,
  type VisibilityContext,
} from '@schemaloom/schema-model';

/**
 * Model builders for this package's specs, mirroring `engine-sdk`'s `fixture-engine.ts`:
 * deliberately NOT exported from `index.ts` or `static.ts`, so nothing reaches `dist`.
 */

interface BaseInit {
  readonly id: string;
  readonly name?: string;
  readonly engineProps?: EngineProps;
  readonly refs?: ObjectRefs;
}

function base(init: BaseInit): {
  id: string;
  name: string;
  version: number;
  engineProps: EngineProps;
  refs?: ObjectRefs;
} {
  return {
    id: init.id,
    name: init.name ?? init.id,
    version: 1,
    engineProps: init.engineProps ?? {},
    ...(init.refs === undefined ? {} : { refs: init.refs }),
  };
}

export function ns(init: BaseInit & { readonly isDefault?: boolean }): Namespace {
  return { ...base(init), isDefault: init.isDefault ?? false };
}

export function table(
  init: BaseInit & {
    readonly namespaceId?: string;
    readonly kind?: string;
    readonly doc?: DocRef;
  },
): Entity {
  return {
    ...base(init),
    namespaceId: init.namespaceId ?? 'db',
    kind: init.kind ?? 'table',
    areaId: null,
    position: { x: 0, y: 0 },
    color: null,
    doc: init.doc ?? null,
  };
}

export function column(
  init: BaseInit & {
    readonly entityId: string;
    readonly type?: TypeRef;
    readonly ordinal?: number;
    readonly isNullable?: boolean;
    readonly isRestricted?: boolean;
    readonly doc?: DocRef;
  },
): Field {
  return {
    ...base(init),
    entityId: init.entityId,
    parentFieldId: null,
    ordinal: init.ordinal ?? 0,
    type: init.type ?? { name: 'integer' },
    isNullable: init.isNullable ?? true,
    isRestricted: init.isRestricted ?? false,
    isPii: false,
    isDeprecated: false,
    doc: init.doc ?? null,
  };
}

export function indexColumn(init: Partial<IndexColumn> = {}): IndexColumn {
  return {
    ordinal: 0,
    fieldId: null,
    expression: null,
    role: 'key',
    engineProps: {},
    ...init,
  };
}

export function index(
  init: BaseInit & {
    readonly entityId: string;
    readonly kind?: string;
    readonly isUnique?: boolean;
    readonly columns?: readonly IndexColumn[];
  },
): Index {
  return {
    ...base(init),
    entityId: init.entityId,
    kind: init.kind ?? 'btree',
    isUnique: init.isUnique ?? false,
    columns: [...(init.columns ?? [])],
  };
}

export function constraint(
  init: BaseInit & {
    readonly entityId: string;
    readonly kind?: string;
    readonly fieldIds?: readonly string[];
  },
): Constraint {
  return {
    ...base(init),
    entityId: init.entityId,
    kind: init.kind ?? 'check',
    fieldIds: [...(init.fieldIds ?? [])],
  };
}

export function link(
  init: BaseInit & {
    readonly kind?: string;
    readonly from: { entityId: string; fieldIds: readonly string[] };
    readonly to: { entityId: string; fieldIds: readonly string[] };
    readonly cardinality?: Link['cardinality'];
  },
): Link {
  return {
    ...base(init),
    kind: init.kind ?? 'foreignKey',
    from: { entityId: init.from.entityId, fieldIds: [...init.from.fieldIds] },
    to: { entityId: init.to.entityId, fieldIds: [...init.to.fieldIds] },
    cardinality: init.cardinality ?? 'N:1',
  };
}

export function customType(
  init: BaseInit & { readonly namespaceId?: string; readonly kind?: string },
): CustomType {
  return {
    ...base(init),
    namespaceId: init.namespaceId ?? 'db',
    kind: init.kind ?? 'enum',
  };
}

function byId<T extends { id: string }>(objects: readonly T[]): Record<string, T> {
  return Object.fromEntries(objects.map((o) => [o.id, o]));
}

export interface ModelParts {
  readonly namespaces?: readonly Namespace[];
  readonly entities?: readonly Entity[];
  readonly fields?: readonly Field[];
  readonly indexes?: readonly Index[];
  readonly constraints?: readonly Constraint[];
  readonly links?: readonly Link[];
  readonly customTypes?: readonly CustomType[];
}

/** A model with the unnamed default namespace (one database) already in it. */
export function model(parts: ModelParts = {}): SchemaModel {
  const namespaces = parts.namespaces ?? [ns({ id: 'db', name: '', isDefault: true })];
  return {
    irVersion: 1,
    projectId: 'p1',
    engineId: 'sqlite',
    engineVersion: '3.45',
    redacted: false,
    objects: {
      area: {},
      namespace: byId(namespaces),
      customType: byId(parts.customTypes ?? []),
      entity: byId(parts.entities ?? []),
      field: byId(parts.fields ?? []),
      constraint: byId(parts.constraints ?? []),
      index: byId(parts.indexes ?? []),
      link: byId(parts.links ?? []),
    },
  };
}

/**
 * §17's `redactForExport`, and the specs' way to reach a `RedactedModel`: the suite's way to hand an importer's output to an exporter that
 * requires a `RedactedModel`.
 *
 * The context is fully permissive on purpose — the round-trip checks are about the exporter's
 * FIDELITY, and `export/skips-restricted` is where its permission behaviour is tested. It is
 * still the real `redact`, so the brand is still only ever minted by the one function doc 05
 * §8.6 allows to mint it.
 */
export function fullyVisible(model: SchemaModel): RedactedModel {
  const entityIds = new Set(Object.keys(model.objects.entity));
  const ctx: VisibilityContext = {
    projectId: model.projectId,
    subjectKind: 'user',
    subjectKey: 'conformance-owner',
    canOpenProject: true,
    visibleEntityIds: entityIds,
    restrictedOkEntityIds: entityIds,
    areasWithAtoms: new Set(),
    restrictedFieldMode: 'mask',
    totalEntityCount: entityIds.size,
    entitiesWithRestrictedFields: new Set(),
  };
  return redact(new RawSchemaModel(model), ctx);
}
