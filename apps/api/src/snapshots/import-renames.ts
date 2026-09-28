import { UnprocessableEntityException } from '@nestjs/common';
import type { Id, SchemaModel } from '@schemaloom/schema-model';
import { SchemaOperationSchema, type SchemaOperation } from '../schema';
import type { LiveIr } from './live-ir';

/** A rename a human confirmed in the import dialog (Phase 4 §2.1). Never inferred. */
export interface ConfirmedRename {
  readonly type: 'entity' | 'field';
  /** The project object the SQL no longer names. */
  readonly fromId: Id;
  /** The name the SQL gives it. */
  readonly toName: string;
}

const refuse = (index: number, reason: string): never => {
  throw new UnprocessableEntityException({ code: 'invalid_rename', index, reason });
};

/**
 * Q1 — the only update a SQL import makes. Each confirmed rename is validated against the
 * FRESH merge (`imported` = the SQL with matched objects carrying live ids), and becomes an
 * ordinary `update { name }` op for `SchemaWriter`, so the object keeps its id and its docs,
 * comments, grants and saved-query links follow it. PURE.
 *
 * Refused (422 `invalid_rename`): an unknown id, an object the SQL still names, a target the
 * SQL does not create, a target in another namespace, a duplicate, a name that collides with
 * a sibling, and a field rename inside an entity that neither matched nor is being renamed.
 */
export function renameOps(
  live: LiveIr,
  imported: SchemaModel,
  renames: readonly ConfirmedRename[],
): SchemaOperation[] {
  const norm = (s: string) => s.trim().toLowerCase();
  const ops: unknown[] = [];
  const seenFrom = new Set<Id>();
  const seenTo = new Set<string>();
  /** Project entity id → the imported entity it is being renamed to. */
  const entityTarget = new Map<Id, Id>();

  const ordered = renames.map((r, index) => ({ ...r, index }));
  // Entities first: a field rename's owner may be one of them.
  ordered.sort((a, b) => (a.type === b.type ? a.index - b.index : a.type === 'entity' ? -1 : 1));

  for (const { type, fromId, toName, index } of ordered) {
    if (seenFrom.has(fromId)) refuse(index, 'duplicate');
    seenFrom.add(fromId);

    if (type === 'entity') {
      const entity = live.objects.entity[fromId] ?? refuse(index, 'unknown_id');
      if (fromId in imported.objects.entity) refuse(index, 'still_in_source');
      const created = Object.values(imported.objects.entity).filter(
        (e) => !(e.id in live.objects.entity) && norm(e.name) === norm(toName),
      );
      const target =
        created.find((e) => e.namespaceId === entity.namespaceId) ??
        refuse(index, created.length > 0 ? 'cross_namespace' : 'unknown_target');
      const collides = Object.values(live.objects.entity).some(
        (e) => e.id !== fromId && e.namespaceId === entity.namespaceId && norm(e.name) === norm(toName),
      );
      if (collides) refuse(index, 'name_collision');
      const key = `ent:${entity.namespaceId}:${norm(toName)}`;
      if (seenTo.has(key)) refuse(index, 'duplicate');
      seenTo.add(key);
      entityTarget.set(fromId, target.id);
      ops.push({
        op: 'update',
        type: 'entity',
        id: fromId,
        expectedVersion: entity.version,
        patch: { name: target.name },
      });
      continue;
    }

    const field = live.objects.field[fromId] ?? refuse(index, 'unknown_id');
    const sqlEntity =
      field.entityId in imported.objects.entity
        ? field.entityId
        : (entityTarget.get(field.entityId) ?? refuse(index, 'entity_not_matched'));
    const sqlFields = Object.values(imported.objects.field).filter((f) => f.entityId === sqlEntity);
    if (sqlFields.some((f) => norm(f.name) === norm(field.name))) refuse(index, 'still_in_source');
    const target =
      sqlFields.find((f) => !(f.id in live.objects.field) && norm(f.name) === norm(toName)) ??
      refuse(index, 'unknown_target');
    const collides = Object.values(live.objects.field).some(
      (f) => f.id !== fromId && f.entityId === field.entityId && norm(f.name) === norm(toName),
    );
    if (collides) refuse(index, 'name_collision');
    const key = `fld:${field.entityId}:${norm(toName)}`;
    if (seenTo.has(key)) refuse(index, 'duplicate');
    seenTo.add(key);
    ops.push({
      op: 'update',
      type: 'field',
      id: fromId,
      expectedVersion: field.version,
      patch: { name: target.name },
    });
  }
  return ops.map((op) => SchemaOperationSchema.parse(op));
}
