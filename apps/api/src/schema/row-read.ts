import {
  ObjectRefsSchema,
  type AssemblyRows,
  type DocRow,
  type ObjectRefs,
  type Props,
} from '@schemaloom/schema-model';
import type { Prisma } from '../generated/prisma/client';

/**
 * Doc 04 §8.1 — the Prisma half of the read path: the `project_id` scans and the
 * column-name mapping onto the row shapes `schema-model` owns.
 *
 * `schema-model` never imports Prisma (C10), so SOMETHING has to sit between the two.
 * This file is that something, and it is deliberately the only one: `SchemaLoader`
 * (whole-project read) and `post-images` (the touched subset after a write) both come
 * through here, so the JSON-column coercion and the `select` lists exist once.
 *
 * The row property names were chosen in doc 04 §8.1 to MATCH the columns (`position`,
 * `method`, `positionX`), so the `select` list is the whole mapping for every type that
 * carries no JSON column, and the four JSON columns are all that need a coercion.
 */

/** Every delegate this module uses exists on both the client and a transaction client. */
export type SchemaDb = Prisma.TransactionClient;

const EMPTY_REFS: ObjectRefs = { entityIds: [], fieldIds: [] };

/**
 * A JSON column is `unknown` as far as core is concerned. Arrays and `null` are rejected
 * rather than coerced, because `EnginePropsSchema` is a record and `{ ...engineProps }`
 * has to stay safe (doc 04 §2.1).
 */
export const toProps = (value: unknown): Props =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Props)
    : {};

/**
 * `refs` is server-owned (§8.3) and doc 05 R27 reads it to decide whether to blank a
 * whole `engineProps` bag. A row whose JSON does not parse therefore resolves to EMPTY,
 * not to a partial set: a half-read ref list would silently un-redact the half it lost.
 */
export const toRefs = (value: unknown): ObjectRefs => {
  const parsed = ObjectRefsSchema.safeParse(value);
  return parsed.success ? parsed.data : EMPTY_REFS;
};

/** `fields.type_args` (doc 02 delta D1). Scalars only; anything else is dropped. */
export const toTypeArgs = (value: unknown): (string | number)[] =>
  Array.isArray(value)
    ? value.filter((a): a is string | number => typeof a === 'string' || typeof a === 'number')
    : [];

interface JsonRow {
  engineProps: unknown;
  refs: unknown;
}

const withJson = <T extends JsonRow>(
  row: T,
): Omit<T, 'engineProps' | 'refs'> & { engineProps: Props; refs: ObjectRefs } => ({
  ...row,
  engineProps: toProps(row.engineProps),
  refs: toRefs(row.refs),
});

const withTypeArgs = <T extends JsonRow & { typeArgs: unknown }>(row: T) => ({
  ...withJson(row),
  typeArgs: toTypeArgs(row.typeArgs),
});

// The `select` lists ARE the row mapping. Keep them beside the row types they produce.

const AREA = { id: true, name: true, color: true, position: true, version: true } as const;

const NAMESPACE = {
  id: true,
  name: true,
  isDefault: true,
  engineProps: true,
  refs: true,
  version: true,
} as const;

const CUSTOM_TYPE = {
  id: true,
  namespaceId: true,
  name: true,
  kind: true,
  engineProps: true,
  refs: true,
  version: true,
} as const;

const ENTITY = {
  id: true,
  namespaceId: true,
  areaId: true,
  name: true,
  kind: true,
  positionX: true,
  positionY: true,
  width: true,
  height: true,
  color: true,
  engineProps: true,
  refs: true,
  version: true,
} as const;

const FIELD = {
  id: true,
  entityId: true,
  parentFieldId: true,
  name: true,
  dataType: true,
  customTypeId: true,
  typeArgs: true,
  typeDimensions: true,
  position: true,
  isNullable: true,
  isRestricted: true,
  isPii: true,
  isDeprecated: true,
  engineProps: true,
  refs: true,
  version: true,
} as const;

const CONSTRAINT = {
  id: true,
  entityId: true,
  name: true,
  kind: true,
  expression: true,
  engineProps: true,
  refs: true,
  version: true,
} as const;

const CONSTRAINT_COLUMN = { constraintId: true, ordinal: true, fieldId: true } as const;

const INDEX = {
  id: true,
  entityId: true,
  name: true,
  method: true,
  isUnique: true,
  engineProps: true,
  refs: true,
  version: true,
} as const;

const INDEX_COLUMN = {
  indexId: true,
  ordinal: true,
  fieldId: true,
  expression: true,
  direction: true,
  isInclude: true,
  engineProps: true,
} as const;

const LINK = {
  id: true,
  name: true,
  kind: true,
  cardinality: true,
  sourceEntityId: true,
  targetEntityId: true,
  engineProps: true,
  refs: true,
  version: true,
} as const;

const LINK_ENDPOINT = {
  linkId: true,
  ordinal: true,
  sourceFieldId: true,
  targetFieldId: true,
} as const;

/** `content` and `structured` (whole TipTap trees) are deliberately not selected. */
const DOC = { id: true, targetType: true, targetId: true, plainText: true } as const;

/** `TargetType` also has `project`, which the IR has no slot for. */
const DOC_TARGETS = ['area', 'entity', 'field'] as const;

const isIrDoc = (row: {
  id: string;
  targetType: 'project' | 'area' | 'entity' | 'field';
  targetId: string;
  plainText: string | null;
}): row is DocRow => row.targetType !== 'project';

/**
 * The whole project, in ONE round of parallel scans — twelve indexed `project_id`
 * queries, no joins, no N+1 (§8.1).
 *
 * `Promise.all` is load-bearing, not stylistic: these are twelve independent index scans
 * and awaiting them in sequence turns one round trip into twelve. Its unit test asserts
 * exactly that.
 */
export async function readProjectRows(db: SchemaDb, projectId: string): Promise<AssemblyRows> {
  const where = { projectId };
  const [
    area,
    namespace,
    customType,
    entity,
    field,
    constraint,
    constraintColumn,
    index,
    indexColumn,
    link,
    linkEndpoint,
    doc,
  ] = await Promise.all([
    db.area.findMany({ where, select: AREA }),
    db.namespace.findMany({ where, select: NAMESPACE }),
    db.customType.findMany({ where, select: CUSTOM_TYPE }),
    db.entity.findMany({ where, select: ENTITY }),
    db.field.findMany({ where, select: FIELD }),
    db.constraint.findMany({ where, select: CONSTRAINT }),
    db.constraintColumn.findMany({ where, select: CONSTRAINT_COLUMN }),
    db.schemaIndex.findMany({ where, select: INDEX }),
    db.schemaIndexColumn.findMany({ where, select: INDEX_COLUMN }),
    db.link.findMany({ where, select: LINK }),
    db.linkEndpoint.findMany({ where, select: LINK_ENDPOINT }),
    db.doc.findMany({
      where: { projectId, targetType: { in: [...DOC_TARGETS] } },
      select: DOC,
    }),
  ]);

  return {
    area,
    namespace: namespace.map(withJson),
    customType: customType.map(withJson),
    entity: entity.map(withJson),
    field: field.map(withTypeArgs),
    constraint: constraint.map(withJson),
    constraintColumn,
    index: index.map(withJson),
    indexColumn: indexColumn.map((c) => ({ ...c, engineProps: toProps(c.engineProps) })),
    link: link.map(withJson),
    linkEndpoint,
    doc: doc.filter(isIrDoc),
  };
}

/** Which ids to read back, per object type. */
export type TouchedIds = Readonly<Record<'area' | 'namespace' | 'customType' | 'entity' | 'field' | 'constraint' | 'index' | 'link', readonly string[]>>;

/**
 * The same shapes, restricted to the objects one batch touched (§8.6 rule 8's
 * post-images). Bounded by the batch, never by the project.
 *
 * `namespace` is read WHOLE regardless: assembly resolves a null `namespace_id` against
 * the default namespace, so a post-image of an entity in the default namespace would
 * otherwise come back with a dangling `namespaceId`. The table has one row per schema.
 */
export async function readTouchedRows(
  db: SchemaDb,
  projectId: string,
  ids: TouchedIds,
): Promise<AssemblyRows> {
  const docTargets = [
    ...ids.area,
    ...ids.entity,
    ...ids.field,
  ];
  const [
    area,
    namespace,
    customType,
    entity,
    field,
    constraint,
    constraintColumn,
    index,
    indexColumn,
    link,
    linkEndpoint,
    doc,
  ] = await Promise.all([
    db.area.findMany({ where: { projectId, id: { in: [...ids.area] } }, select: AREA }),
    db.namespace.findMany({ where: { projectId }, select: NAMESPACE }),
    db.customType.findMany({
      where: { projectId, id: { in: [...ids.customType] } },
      select: CUSTOM_TYPE,
    }),
    db.entity.findMany({ where: { projectId, id: { in: [...ids.entity] } }, select: ENTITY }),
    db.field.findMany({ where: { projectId, id: { in: [...ids.field] } }, select: FIELD }),
    db.constraint.findMany({
      where: { projectId, id: { in: [...ids.constraint] } },
      select: CONSTRAINT,
    }),
    db.constraintColumn.findMany({
      where: { projectId, constraintId: { in: [...ids.constraint] } },
      select: CONSTRAINT_COLUMN,
    }),
    db.schemaIndex.findMany({ where: { projectId, id: { in: [...ids.index] } }, select: INDEX }),
    db.schemaIndexColumn.findMany({
      where: { projectId, indexId: { in: [...ids.index] } },
      select: INDEX_COLUMN,
    }),
    db.link.findMany({ where: { projectId, id: { in: [...ids.link] } }, select: LINK }),
    db.linkEndpoint.findMany({
      where: { projectId, linkId: { in: [...ids.link] } },
      select: LINK_ENDPOINT,
    }),
    db.doc.findMany({
      where: { projectId, targetType: { in: [...DOC_TARGETS] }, targetId: { in: docTargets } },
      select: DOC,
    }),
  ]);

  return {
    area,
    namespace: namespace.map(withJson),
    customType: customType.map(withJson),
    entity: entity.map(withJson),
    field: field.map(withTypeArgs),
    constraint: constraint.map(withJson),
    constraintColumn,
    index: index.map(withJson),
    indexColumn: indexColumn.map((c) => ({ ...c, engineProps: toProps(c.engineProps) })),
    link: link.map(withJson),
    linkEndpoint,
    doc: doc.filter(isIrDoc),
  };
}
