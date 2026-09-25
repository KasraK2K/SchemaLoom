import { UnprocessableEntityException } from '@nestjs/common';
import { MAX_FIELD_DEPTH, type Id, type IrObjectType } from '@schemaloom/schema-model';
import type { SchemaDb } from './row-read';
import { bumpVersions } from './row-write';

/**
 * Doc 04 §8.6 RULE 8 — cascades are server-side, and they produce MODIFICATIONS as well
 * as removals. Both kinds are reported.
 *
 * | Deleting | Removed | Modified (post-image, version bumped) |
 * |---|---|---|
 * | a field | its descendants; the index/constraint/link child rows naming it | the owning `index`, `constraint` and `link` |
 * | an entity | its fields, indexes, constraints, and every link touching it | — |
 * | a namespace / customType | nothing — the API REFUSES while anything references it | — |
 * | an area | — | its member entities, each with `areaId: null` |
 *
 * Revision 1's worst convergence bug lived here: an index, constraint or link modified by
 * someone else's field delete appeared in neither `removed` nor `changed`, so every other
 * client kept rendering a column that no longer existed and every later write against
 * that object 409'd permanently for a reason nobody could see.
 *
 * **An emptied link endpoint does NOT delete the link.** It survives with both
 * `fieldIds` empty and becomes an entity-level link, which §2.7 already declares legal.
 * That matches the store exactly (`link_endpoints` rows cascade away, the `links` row
 * does not) and it is the less destructive reading — dropping a column should not
 * silently erase the relationship line a human drew.
 */
export interface CascadeResult {
  readonly removed: { type: IrObjectType; id: Id }[];
  readonly modified: { type: IrObjectType; id: Id }[];
}

export async function cascadeDelete(
  db: SchemaDb,
  projectId: Id,
  type: IrObjectType,
  id: Id,
): Promise<CascadeResult> {
  switch (type) {
    case 'field':
      return deleteField(db, projectId, id);
    case 'entity':
      return deleteEntity(db, projectId, id);
    case 'area':
      return deleteArea(db, projectId, id);
    case 'namespace':
      return deleteNamespace(db, projectId, id);
    case 'customType':
      return deleteCustomType(db, projectId, id);
    case 'index': {
      await db.schemaIndex.deleteMany({ where: { projectId, id } });
      return { removed: [{ type, id }], modified: [] };
    }
    case 'constraint': {
      await db.constraint.deleteMany({ where: { projectId, id } });
      return { removed: [{ type, id }], modified: [] };
    }
    case 'link': {
      await db.link.deleteMany({ where: { projectId, id } });
      return { removed: [{ type, id }], modified: [] };
    }
  }
}

/**
 * The descendant walk is iterative and BOUNDED BY `MAX_FIELD_DEPTH`. Postgres would do
 * this in one recursive CTE, but a raw query here would bypass the `projectId` scoping
 * every other statement in this module carries (C6), and v1's only engine reports
 * `supportsNestedFields: false`, so the loop runs once in practice.
 */
async function deleteField(db: SchemaDb, projectId: Id, id: Id): Promise<CascadeResult> {
  const fieldIds: Id[] = [id];
  let frontier: Id[] = [id];
  for (let depth = 0; depth < MAX_FIELD_DEPTH && frontier.length > 0; depth += 1) {
    const children = await db.field.findMany({
      where: { projectId, parentFieldId: { in: frontier } },
      select: { id: true },
    });
    frontier = children.map((c) => c.id);
    fieldIds.push(...frontier);
  }

  // Read the owners BEFORE the delete: the child rows that name these fields are gone
  // the moment it runs (`onDelete: Cascade`), and with them any way to find them.
  const [indexColumns, constraintColumns, endpoints] = await Promise.all([
    db.schemaIndexColumn.findMany({
      where: { projectId, fieldId: { in: fieldIds } },
      select: { indexId: true },
    }),
    db.constraintColumn.findMany({
      where: { projectId, fieldId: { in: fieldIds } },
      select: { constraintId: true },
    }),
    db.linkEndpoint.findMany({
      where: {
        projectId,
        OR: [{ sourceFieldId: { in: fieldIds } }, { targetFieldId: { in: fieldIds } }],
      },
      select: { linkId: true },
    }),
  ]);

  const indexIds = unique(indexColumns.map((c) => c.indexId));
  const constraintIds = unique(constraintColumns.map((c) => c.constraintId));
  const linkIds = unique(endpoints.map((e) => e.linkId));

  // The child rows are removed EXPLICITLY rather than left to `onDelete: Cascade`. The
  // database would do it either way; doing it here means the behaviour this module
  // promises does not depend on a referential action in a migration nobody re-reads, and
  // it is the same three statements Postgres would have run.
  await Promise.all([
    db.schemaIndexColumn.deleteMany({ where: { projectId, fieldId: { in: fieldIds } } }),
    db.constraintColumn.deleteMany({ where: { projectId, fieldId: { in: fieldIds } } }),
    db.linkEndpoint.deleteMany({
      where: {
        projectId,
        OR: [{ sourceFieldId: { in: fieldIds } }, { targetFieldId: { in: fieldIds } }],
      },
    }),
  ]);
  await db.field.deleteMany({ where: { projectId, id: { in: fieldIds } } });

  await Promise.all([
    bumpVersions(db, projectId, 'index', indexIds),
    bumpVersions(db, projectId, 'constraint', constraintIds),
    bumpVersions(db, projectId, 'link', linkIds),
  ]);

  return {
    removed: fieldIds.map((fieldId) => ({ type: 'field' as const, id: fieldId })),
    modified: [
      ...indexIds.map((i) => ({ type: 'index' as const, id: i })),
      ...constraintIds.map((c) => ({ type: 'constraint' as const, id: c })),
      ...linkIds.map((l) => ({ type: 'link' as const, id: l })),
    ],
  };
}

async function deleteEntity(db: SchemaDb, projectId: Id, id: Id): Promise<CascadeResult> {
  const [fields, indexes, constraints, links] = await Promise.all([
    db.field.findMany({ where: { projectId, entityId: id }, select: { id: true } }),
    db.schemaIndex.findMany({ where: { projectId, entityId: id }, select: { id: true } }),
    db.constraint.findMany({ where: { projectId, entityId: id }, select: { id: true } }),
    db.link.findMany({
      where: { projectId, OR: [{ sourceEntityId: id }, { targetEntityId: id }] },
      select: { id: true },
    }),
  ]);

  await db.entity.deleteMany({ where: { projectId, id } });

  return {
    removed: [
      { type: 'entity', id },
      ...fields.map((r) => ({ type: 'field' as const, id: r.id })),
      ...indexes.map((r) => ({ type: 'index' as const, id: r.id })),
      ...constraints.map((r) => ({ type: 'constraint' as const, id: r.id })),
      ...links.map((r) => ({ type: 'link' as const, id: r.id })),
    ],
    modified: [],
  };
}

/**
 * `entities.area_id` is `onDelete: SetNull`, so the members SURVIVE with `areaId: null`
 * and must be reported as modified — otherwise every other client keeps rendering them
 * inside an Area that no longer exists.
 *
 * The grants and access requests scoped to the Area are deleted by the access module's
 * own cleanup (doc 05 §7.11): they are not rows this module is allowed to touch.
 */
async function deleteArea(db: SchemaDb, projectId: Id, id: Id): Promise<CascadeResult> {
  const members = await db.entity.findMany({
    where: { projectId, areaId: id },
    select: { id: true },
  });
  await db.area.deleteMany({ where: { projectId, id } });
  const memberIds = members.map((m) => m.id);
  await bumpVersions(db, projectId, 'entity', memberIds);
  return {
    removed: [{ type: 'area', id }],
    modified: memberIds.map((memberId) => ({ type: 'entity' as const, id: memberId })),
  };
}

/** `onDelete: Restrict` in spirit — the API refuses while anything still points here, so
 *  the user gets a typed 422 naming the blocker instead of a raw FK violation. */
async function deleteNamespace(db: SchemaDb, projectId: Id, id: Id): Promise<CascadeResult> {
  const [entities, customTypes] = await Promise.all([
    db.entity.count({ where: { projectId, namespaceId: id } }),
    db.customType.count({ where: { projectId, namespaceId: id } }),
  ]);
  if (entities + customTypes > 0) {
    throw new UnprocessableEntityException({
      code: 'namespace_in_use',
      resourceType: 'namespace',
      id,
      entities,
      customTypes,
    });
  }
  await db.namespace.deleteMany({ where: { projectId, id } });
  return { removed: [{ type: 'namespace', id }], modified: [] };
}

async function deleteCustomType(db: SchemaDb, projectId: Id, id: Id): Promise<CascadeResult> {
  const fields = await db.field.count({ where: { projectId, customTypeId: id } });
  if (fields > 0) {
    throw new UnprocessableEntityException({
      code: 'custom_type_in_use',
      resourceType: 'customType',
      id,
      fields,
    });
  }
  await db.customType.deleteMany({ where: { projectId, id } });
  return { removed: [{ type: 'customType', id }], modified: [] };
}

const unique = (ids: readonly Id[]): Id[] => [...new Set(ids)];
