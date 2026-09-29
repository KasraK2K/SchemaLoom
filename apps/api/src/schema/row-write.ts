import type {
  Area,
  Constraint,
  CustomType,
  Entity,
  Field,
  Id,
  Index,
  IrObjectType,
  Link,
  Namespace,
} from '@schemaloom/schema-model';
import type { Prisma } from '../generated/prisma/client';
import type { SchemaDb } from './row-read';

/**
 * Doc 04 §8.1, write direction — IR object in, row columns out.
 *
 * The read direction lives in `row-read.ts`; this is its mirror, and the two are the only
 * places in the codebase that know a `Field.type` is three columns or that an
 * `IndexColumn.role` is `is_include`. Everything above this file speaks IR.
 *
 * `undefined` is never written: Prisma treats an undefined property as "leave this
 * column alone", which is exactly patch semantics, so a `Partial<Entity>` maps to an
 * update payload with no conditional spreading and no delete-a-key sentinel.
 */

/** The one JSON cast. `engineProps` is `Record<string, unknown>` by design (C4) and
 *  Prisma's input type is a closed JSON union; nothing checks the bag here because the
 *  engine's `propsSchemas` validate it one stage earlier (§8.6 rule 9). */
const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

const optionalJson = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined ? undefined : json(value);

/** doc 04 §8.1's mapping table, the only place it is spelled in this direction. */
const CARDINALITY = {
  '1:1': 'one_to_one',
  '1:N': 'one_to_many',
  'N:1': 'many_to_one',
  'N:M': 'many_to_many',
} as const;

/** `constraints.expression` stays a real column; assembly copies it INTO the bag, so the
 *  write path copies it back out. Doc 04 §8.1 resolved this divergence that way rather
 *  than making doc 02 drop the column. */
const expressionOf = (props: Record<string, unknown> | undefined): string | null | undefined => {
  if (props === undefined) return undefined;
  const value = props.expression;
  return typeof value === 'string' ? value : null;
};

/** `TypeRef` is three columns plus a foreign key (doc 02 delta D1): `varchar(255)` has to
 *  diff as one structural change, not as `type.args.0` AND `engineProps.length`. */
const typeColumns = (type: Field['type']) => ({
  dataType: type.name,
  customTypeId: type.customTypeId ?? null,
  typeArgs: json(type.args ?? []),
  typeDimensions: type.dimensions ?? 0,
});

/**
 * Constraint and link names are nullable in the store and `''` in the IR (assembly maps
 * null → ''). Writing `''` back would put every unnamed constraint on the partial
 * `lower(name)` unique index — which skips only NULL — so a second unnamed PK collides.
 */
const storedName = (name: string): string | null => (name === '' ? null : name);

/** All four undefined when the patch does not name `type` — Prisma's "leave it alone". */
const typeColumnsPatch = (type: Field['type'] | undefined) =>
  type === undefined
    ? {
        dataType: undefined,
        customTypeId: undefined,
        typeArgs: undefined,
        typeDimensions: undefined,
      }
    : typeColumns(type);

const indexColumnRows = (projectId: Id, columns: Index['columns']) =>
  columns.map((c) => ({
    projectId,
    ordinal: c.ordinal,
    fieldId: c.fieldId,
    expression: c.expression,
    direction: c.direction ?? 'asc',
    isInclude: c.role === 'include',
    engineProps: json(c.engineProps),
  }));

const constraintColumnRows = (projectId: Id, fieldIds: readonly Id[]) =>
  fieldIds.map((fieldId, ordinal) => ({ projectId, ordinal, fieldId }));

/** ONE row carries BOTH field ids, which is what structurally guarantees
 *  `from.fieldIds.length === to.fieldIds.length` (§8.1). A side with fewer ids than the
 *  other truncates rather than inventing a pairing. */
const endpointRows = (projectId: Id, link: Pick<Link, 'from' | 'to'>) => {
  const pairs = Math.min(link.from.fieldIds.length, link.to.fieldIds.length);
  const rows: { projectId: Id; ordinal: number; sourceFieldId: Id; targetFieldId: Id }[] = [];
  for (let i = 0; i < pairs; i += 1) {
    const sourceFieldId = link.from.fieldIds[i];
    const targetFieldId = link.to.fieldIds[i];
    if (sourceFieldId === undefined || targetFieldId === undefined) break;
    rows.push({ projectId, ordinal: i, sourceFieldId, targetFieldId });
  }
  return rows;
};

// ── creates ────────────────────────────────────────────────────────────────────────

export interface CreatePayloads {
  area: Omit<Area, 'version' | 'restricted' | 'propsRedacted' | 'refs' | 'doc'>;
  namespace: Omit<Namespace, 'version' | 'restricted' | 'propsRedacted' | 'refs'>;
  customType: Omit<CustomType, 'version' | 'restricted' | 'propsRedacted' | 'refs'>;
  entity: Omit<Entity, 'version' | 'restricted' | 'propsRedacted' | 'refs' | 'doc'>;
  field: Omit<Field, 'version' | 'restricted' | 'propsRedacted' | 'refs' | 'doc' | 'ordinal'>;
  constraint: Omit<Constraint, 'version' | 'restricted' | 'propsRedacted' | 'refs'>;
  index: Omit<Index, 'version' | 'restricted' | 'propsRedacted' | 'refs'>;
  link: Omit<Link, 'version' | 'restricted' | 'propsRedacted' | 'refs'>;
}

/**
 * `projectId` is ALWAYS set by the server (§8.6 rule 3): the id in the payload is
 * client-minted cuid2 so a single batch can create an entity and the fields that point
 * at it, but a client-supplied id is never trusted for TENANCY.
 *
 * `ordinal` for a field is passed in, not read off the payload — the caller computed it
 * inside the transaction (§8.6 rule 6).
 */
export async function createRow(
  db: SchemaDb,
  projectId: Id,
  op: { [K in keyof CreatePayloads]: { type: K; object: CreatePayloads[K] } }[keyof CreatePayloads],
  ordinal: number,
): Promise<void> {
  switch (op.type) {
    case 'area':
      // `areas` carries no `engine_props` column: an Area's bag is always `{}` (§2.11).
      await db.area.create({
        data: {
          id: op.object.id,
          projectId,
          name: op.object.name,
          color: op.object.color,
          position: op.object.ordinal,
        },
      });
      return;
    case 'namespace':
      await db.namespace.create({
        data: {
          id: op.object.id,
          projectId,
          name: op.object.name,
          isDefault: op.object.isDefault,
          engineProps: json(op.object.engineProps),
        },
      });
      return;
    case 'customType':
      await db.customType.create({
        data: {
          id: op.object.id,
          projectId,
          namespaceId: op.object.namespaceId,
          name: op.object.name,
          kind: op.object.kind,
          engineProps: json(op.object.engineProps),
        },
      });
      return;
    case 'entity':
      await db.entity.create({
        data: {
          id: op.object.id,
          projectId,
          namespaceId: op.object.namespaceId,
          areaId: op.object.areaId,
          name: op.object.name,
          kind: op.object.kind,
          positionX: op.object.position.x,
          positionY: op.object.position.y,
          width: op.object.width ?? null,
          height: op.object.height ?? null,
          color: op.object.color,
          engineProps: json(op.object.engineProps),
        },
      });
      return;
    case 'field':
      await db.field.create({
        data: {
          id: op.object.id,
          projectId,
          entityId: op.object.entityId,
          parentFieldId: op.object.parentFieldId,
          name: op.object.name,
          position: ordinal,
          isNullable: op.object.isNullable,
          isRestricted: op.object.isRestricted,
          isPii: op.object.isPii,
          isDeprecated: op.object.isDeprecated,
          engineProps: json(op.object.engineProps),
          ...typeColumns(op.object.type),
        },
      });
      return;
    case 'constraint':
      await db.constraint.create({
        data: {
          id: op.object.id,
          projectId,
          entityId: op.object.entityId,
          name: storedName(op.object.name),
          kind: op.object.kind,
          expression: expressionOf(op.object.engineProps) ?? null,
          engineProps: json(op.object.engineProps),
          columns: { create: constraintColumnRows(projectId, op.object.fieldIds) },
        },
      });
      return;
    case 'index':
      await db.schemaIndex.create({
        data: {
          id: op.object.id,
          projectId,
          entityId: op.object.entityId,
          name: op.object.name,
          method: op.object.kind,
          isUnique: op.object.isUnique,
          engineProps: json(op.object.engineProps),
          columns: { create: indexColumnRows(projectId, op.object.columns) },
        },
      });
      return;
    case 'link':
      await db.link.create({
        data: {
          id: op.object.id,
          projectId,
          name: storedName(op.object.name),
          kind: op.object.kind,
          cardinality: CARDINALITY[op.object.cardinality],
          sourceEntityId: op.object.from.entityId,
          targetEntityId: op.object.to.entityId,
          engineProps: json(op.object.engineProps),
          endpoints: { create: endpointRows(projectId, op.object) },
        },
      });
      return;
  }
}

// ── updates ────────────────────────────────────────────────────────────────────────

/**
 * Scalar columns only, guarded by `version` (C7): `updateMany` with the expected version
 * in the WHERE is what makes the check atomic with the write, so a racing commit between
 * the pre-read and here loses instead of silently overwriting.
 *
 * @returns false when the guard matched nothing — a version conflict.
 */
export async function updateRow(
  db: SchemaDb,
  projectId: Id,
  type: IrObjectType,
  id: Id,
  expectedVersion: number,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const where = { id, projectId, version: expectedVersion };
  const bump = { version: { increment: 1 } } as const;
  const count = await scalarUpdate(db, where, bump, type, patch);
  return count === 1;
}

interface VersionedWhere {
  id: Id;
  projectId: Id;
  version: number;
}
interface Bump {
  version: { increment: number };
}

async function scalarUpdate(
  db: SchemaDb,
  where: VersionedWhere,
  bump: Bump,
  type: IrObjectType,
  raw: Record<string, unknown>,
): Promise<number> {
  switch (type) {
    case 'area': {
      const p = raw as Partial<Area>;
      const { count } = await db.area.updateMany({
        where,
        data: { ...bump, name: p.name, color: p.color, position: p.ordinal },
      });
      return count;
    }
    case 'namespace': {
      const p = raw as Partial<Namespace>;
      const { count } = await db.namespace.updateMany({
        where,
        data: {
          ...bump,
          name: p.name,
          isDefault: p.isDefault,
          engineProps: optionalJson(p.engineProps),
        },
      });
      return count;
    }
    case 'customType': {
      const p = raw as Partial<CustomType>;
      const { count } = await db.customType.updateMany({
        where,
        data: {
          ...bump,
          name: p.name,
          kind: p.kind,
          namespaceId: p.namespaceId,
          engineProps: optionalJson(p.engineProps),
        },
      });
      return count;
    }
    case 'entity': {
      const p = raw as Partial<Entity>;
      const { count } = await db.entity.updateMany({
        where,
        data: {
          ...bump,
          name: p.name,
          kind: p.kind,
          namespaceId: p.namespaceId,
          areaId: p.areaId,
          color: p.color,
          engineProps: optionalJson(p.engineProps),
        },
      });
      return count;
    }
    case 'field': {
      const p = raw as Partial<Field>;
      const { count } = await db.field.updateMany({
        where,
        data: {
          ...bump,
          name: p.name,
          entityId: p.entityId,
          parentFieldId: p.parentFieldId,
          isNullable: p.isNullable,
          isRestricted: p.isRestricted,
          isPii: p.isPii,
          isDeprecated: p.isDeprecated,
          engineProps: optionalJson(p.engineProps),
          ...typeColumnsPatch(p.type),
        },
      });
      return count;
    }
    case 'constraint': {
      const p = raw as Partial<Constraint>;
      const { count } = await db.constraint.updateMany({
        where,
        data: {
          ...bump,
          name: p.name === undefined ? undefined : storedName(p.name),
          kind: p.kind,
          entityId: p.entityId,
          expression: expressionOf(p.engineProps),
          engineProps: optionalJson(p.engineProps),
        },
      });
      return count;
    }
    case 'index': {
      const p = raw as Partial<Index>;
      const { count } = await db.schemaIndex.updateMany({
        where,
        data: {
          ...bump,
          name: p.name,
          method: p.kind,
          entityId: p.entityId,
          isUnique: p.isUnique,
          engineProps: optionalJson(p.engineProps),
        },
      });
      return count;
    }
    case 'link': {
      const p = raw as Partial<Link>;
      const { count } = await db.link.updateMany({
        where,
        data: {
          ...bump,
          name: p.name === undefined ? undefined : storedName(p.name),
          kind: p.kind,
          cardinality: p.cardinality === undefined ? undefined : CARDINALITY[p.cardinality],
          sourceEntityId: p.from?.entityId,
          targetEntityId: p.to?.entityId,
          engineProps: optionalJson(p.engineProps),
        },
      });
      return count;
    }
  }
}

/**
 * §8.6 rule 4 — an ordered child collection is REPLACED WHOLESALE, never merged. Merge
 * semantics need a delete-a-key sentinel and produce ambiguous diffs; the client always
 * holds the whole object anyway.
 *
 * Only reached for an object rule 1 already proved fully visible, which is what stops
 * this being doc 05 R22's full-list-replacement hazard.
 */
export async function replaceChildren(
  db: SchemaDb,
  projectId: Id,
  type: IrObjectType,
  id: Id,
  patch: Record<string, unknown>,
): Promise<void> {
  if (type === 'index' && patch.columns !== undefined) {
    const columns = (patch as Partial<Index>).columns ?? [];
    await db.schemaIndexColumn.deleteMany({ where: { projectId, indexId: id } });
    await db.schemaIndexColumn.createMany({
      data: indexColumnRows(projectId, columns).map((c) => ({ ...c, indexId: id })),
    });
    return;
  }
  if (type === 'constraint' && patch.fieldIds !== undefined) {
    const fieldIds = (patch as Partial<Constraint>).fieldIds ?? [];
    await db.constraintColumn.deleteMany({ where: { projectId, constraintId: id } });
    await db.constraintColumn.createMany({
      data: constraintColumnRows(projectId, fieldIds).map((c) => ({ ...c, constraintId: id })),
    });
    return;
  }
  if (type === 'link' && (patch.from !== undefined || patch.to !== undefined)) {
    const p = patch as Partial<Link>;
    if (p.from === undefined || p.to === undefined) return;
    await db.linkEndpoint.deleteMany({ where: { projectId, linkId: id } });
    await db.linkEndpoint.createMany({
      data: endpointRows(projectId, { from: p.from, to: p.to }).map((e) => ({ ...e, linkId: id })),
    });
  }
}

/**
 * §8.6 rule 8 — a cascade-modified object is version-bumped WITHOUT an
 * `expectedVersion` guard, because the client that triggered the cascade never held its
 * version. Revision 1 skipped the bump and the post-image entirely, so every other
 * client kept rendering a column that no longer existed and every later write against
 * that object 409'd forever.
 */
export async function bumpVersions(
  db: SchemaDb,
  projectId: Id,
  type: 'index' | 'constraint' | 'link' | 'entity' | 'field',
  ids: readonly Id[],
): Promise<void> {
  if (ids.length === 0) return;
  const where = { projectId, id: { in: [...ids] } };
  const data = { version: { increment: 1 } };
  switch (type) {
    case 'index':
      await db.schemaIndex.updateMany({ where, data });
      return;
    case 'constraint':
      await db.constraint.updateMany({ where, data });
      return;
    case 'link':
      await db.link.updateMany({ where, data });
      return;
    case 'entity':
      await db.entity.updateMany({ where, data });
      return;
    case 'field':
      await db.field.updateMany({ where, data });
      return;
  }
}
