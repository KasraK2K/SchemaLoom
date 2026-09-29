import type { Area } from './area.js';
import type { ObjectRefs } from './base.js';
import { groupBy, sortBuckets } from './collect.js';
import type { Constraint } from './constraint.js';
import type { CustomType } from './custom-type.js';
import { DOC_EXCERPT_CHARS, type DocRef } from './doc-ref.js';
import type { Entity } from './entity.js';
import type { Field } from './field.js';
import type { Id } from './ids.js';
import type { Index, IndexColumn } from './ir-index.js';
import type { Cardinality, Link } from './link.js';
import { emptyCollections, type IrCollections, type SchemaModel } from './model.js';
import type { Namespace } from './namespace.js';
import type { AssemblyInput, DocRow, LinkRow } from './rows.js';

/**
 * The read path (§8.1): plain rows in, IR out.
 *
 * ENGINE-FREE BY CONSTRUCTION, not by convention. `AssemblyInput` admits data and
 * nothing else — no engine, no registry, no capability object, no callback — so there
 * is no engine here to import, call or branch on. `engineId` and `engineVersion` are
 * copied through as opaque strings. That is the whole guarantee; it needs no discipline
 * to hold.
 *
 * Pure, no I/O, and it NEVER THROWS on referential problems: a dangling `entityId`
 * survives into the model and `validateModel` (§11.1) is what reports it. `redacted` is
 * always `false` — only `VisibilityFilter` (§10) produces a redacted model.
 */

const CARDINALITY = {
  one_to_one: '1:1',
  one_to_many: '1:N',
  many_to_one: 'N:1',
  many_to_many: 'N:M',
} as const satisfies Record<LinkRow['cardinality'], Cardinality>;

const byOrdinal = (a: { ordinal: number }, b: { ordinal: number }): number => a.ordinal - b.ordinal;

/** Absent when nothing is referenced, so an unreferencing object adds nothing to the
 *  payload (§8.1). */
function refsOf(refs: ObjectRefs): ObjectRefs | undefined {
  return refs.entityIds.length === 0 && refs.fieldIds.length === 0 ? undefined : refs;
}

/** At most `DOC_EXCERPT_CHARS`, cut on a word boundary, "…" when truncated (§2.3). */
function excerpt(text: string): string {
  if (text.length <= DOC_EXCERPT_CHARS) return text;
  const cut = text.slice(0, DOC_EXCERPT_CHARS);
  const head = cut.replace(/\s+\S*$/, '');
  return `${head === '' ? cut : head}…`;
}

function docKey(targetType: DocRow['targetType'], targetId: Id): string {
  return `${targetType}:${targetId}`;
}

function direction(raw: string): IndexColumn['direction'] {
  return raw === 'asc' || raw === 'desc' ? raw : undefined;
}

export function assembleModel(input: AssemblyInput): SchemaModel {
  const { rows } = input;
  const objects: IrCollections = emptyCollections();

  // A store row may leave `namespace_id` null; the IR is always explicit (§2.4). With no
  // default namespace row at all the reference dangles by design — validateModel reports
  // it rather than assembly inventing a namespace.
  const defaultNamespaceId: Id =
    rows.namespace.find((n) => n.isDefault)?.id ?? rows.namespace[0]?.id ?? '';

  const docs = new Map<string, DocRef>();
  for (const row of rows.doc) {
    docs.set(docKey(row.targetType, row.targetId), {
      id: row.id,
      excerpt: excerpt(row.plainText ?? ''),
    });
  }
  const docOf = (targetType: DocRow['targetType'], targetId: Id): DocRef | null =>
    docs.get(docKey(targetType, targetId)) ?? null;

  for (const row of rows.area) {
    const area: Area = {
      id: row.id,
      name: row.name,
      version: row.version,
      // Permanently `{}` (§2.11) — an Area has no engine vocabulary and no props column.
      engineProps: {},
      color: row.color,
      ordinal: row.position,
      doc: docOf('area', row.id),
    };
    objects.area[row.id] = area;
  }

  for (const row of rows.namespace) {
    const namespace: Namespace = {
      id: row.id,
      name: row.name,
      version: row.version,
      engineProps: row.engineProps,
      refs: refsOf(row.refs),
      isDefault: row.isDefault,
    };
    objects.namespace[row.id] = namespace;
  }

  for (const row of rows.customType) {
    const customType: CustomType = {
      id: row.id,
      name: row.name,
      version: row.version,
      engineProps: row.engineProps,
      refs: refsOf(row.refs),
      namespaceId: row.namespaceId ?? defaultNamespaceId,
      kind: row.kind,
    };
    objects.customType[row.id] = customType;
  }

  for (const row of rows.entity) {
    const entity: Entity = {
      id: row.id,
      name: row.name,
      version: row.version,
      engineProps: row.engineProps,
      refs: refsOf(row.refs),
      namespaceId: row.namespaceId ?? defaultNamespaceId,
      kind: row.kind,
      areaId: row.areaId,
      position: { x: row.positionX, y: row.positionY },
      width: row.width ?? undefined,
      height: row.height ?? undefined,
      color: row.color,
      doc: docOf('entity', row.id),
    };
    objects.entity[row.id] = entity;
  }

  for (const row of rows.field) {
    const field: Field = {
      id: row.id,
      name: row.name,
      version: row.version,
      engineProps: row.engineProps,
      refs: refsOf(row.refs),
      entityId: row.entityId,
      parentFieldId: row.parentFieldId,
      ordinal: row.position,
      type: {
        name: row.dataType,
        args: row.typeArgs.length > 0 ? [...row.typeArgs] : undefined,
        customTypeId: row.customTypeId,
        dimensions: row.typeDimensions > 0 ? row.typeDimensions : undefined,
      },
      isNullable: row.isNullable,
      isRestricted: row.isRestricted,
      isPii: row.isPii,
      isDeprecated: row.isDeprecated,
      doc: docOf('field', row.id),
    };
    objects.field[row.id] = field;
  }

  const constraintColumns = sortBuckets(
    groupBy(rows.constraintColumn, (c) => c.constraintId),
    byOrdinal,
  );
  for (const row of rows.constraint) {
    const constraint: Constraint = {
      id: row.id,
      // Unnamed constraints are ordinary; `logicalKey` falls back to id (§6.1).
      name: row.name ?? '',
      version: row.version,
      engineProps:
        row.expression === null
          ? row.engineProps
          : { ...row.engineProps, expression: row.expression },
      refs: refsOf(row.refs),
      entityId: row.entityId,
      kind: row.kind,
      fieldIds: (constraintColumns.get(row.id) ?? []).map((c) => c.fieldId),
    };
    objects.constraint[row.id] = constraint;
  }

  const indexColumns = sortBuckets(
    groupBy(rows.indexColumn, (c) => c.indexId),
    byOrdinal,
  );
  for (const row of rows.index) {
    const index: Index = {
      id: row.id,
      name: row.name,
      version: row.version,
      engineProps: row.engineProps,
      refs: refsOf(row.refs),
      entityId: row.entityId,
      kind: row.method,
      isUnique: row.isUnique,
      columns: (indexColumns.get(row.id) ?? []).map((c) => ({
        ordinal: c.ordinal,
        fieldId: c.fieldId,
        expression: c.expression,
        role: c.isInclude ? 'include' : 'key',
        direction: direction(c.direction),
        engineProps: c.engineProps,
      })),
    };
    objects.index[row.id] = index;
  }

  const linkEndpoints = sortBuckets(
    groupBy(rows.linkEndpoint, (e) => e.linkId),
    byOrdinal,
  );
  for (const row of rows.link) {
    const endpoints = linkEndpoints.get(row.id) ?? [];
    const link: Link = {
      id: row.id,
      name: row.name ?? '',
      version: row.version,
      engineProps: row.engineProps,
      refs: refsOf(row.refs),
      kind: row.kind,
      from: { entityId: row.sourceEntityId, fieldIds: endpoints.map((e) => e.sourceFieldId) },
      to: { entityId: row.targetEntityId, fieldIds: endpoints.map((e) => e.targetFieldId) },
      cardinality: CARDINALITY[row.cardinality],
    };
    objects.link[row.id] = link;
  }

  return {
    irVersion: 1,
    projectId: input.projectId,
    engineId: input.engineId,
    engineVersion: input.engineVersion,
    redacted: false,
    objects,
  };
}
