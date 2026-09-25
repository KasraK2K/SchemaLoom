import type { Id, IrObjectType } from '@schemaloom/schema-model';
import type { SchemaDb } from './row-read';

/**
 * C7 / doc 04 §8.6 rule 9 — the `expectedVersion` read, one query per touched TYPE and
 * never one per object.
 *
 * This read exists only to build a useful 409 body (`actualVersion`, and the redacted
 * `current` so the client can rebase without a refetch). The check that actually
 * ENFORCES the version is the `version` column in `updateRow`'s WHERE clause, which is
 * atomic with the write; this pre-read would otherwise be a time-of-check/time-of-use
 * window.
 */
export async function readVersions(
  db: SchemaDb,
  projectId: Id,
  type: IrObjectType,
  ids: readonly Id[],
): Promise<Map<Id, number>> {
  if (ids.length === 0) return new Map();
  const rows = await versionRows(db, projectId, type, [...ids]);
  return new Map(rows.map((r) => [r.id, r.version]));
}

/** A switch rather than a delegate lookup table: a union of Prisma delegates has no
 *  callable common signature, so the table would need a cast the switch does not. */
function versionRows(
  db: SchemaDb,
  projectId: Id,
  type: IrObjectType,
  ids: Id[],
): Promise<{ id: Id; version: number }[]> {
  const where = { projectId, id: { in: ids } };
  const select = { id: true, version: true } as const;
  switch (type) {
    case 'area':
      return db.area.findMany({ where, select });
    case 'namespace':
      return db.namespace.findMany({ where, select });
    case 'customType':
      return db.customType.findMany({ where, select });
    case 'entity':
      return db.entity.findMany({ where, select });
    case 'field':
      return db.field.findMany({ where, select });
    case 'constraint':
      return db.constraint.findMany({ where, select });
    case 'index':
      return db.schemaIndex.findMany({ where, select });
    case 'link':
      return db.link.findMany({ where, select });
  }
}
