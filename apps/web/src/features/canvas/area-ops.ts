import type { Area, Id, SchemaModel } from '@schemaloom/schema-model';

/**
 * The writes behind the area gestures (docs/phase23/AREA-CARDS.md §3). Each builder returns
 * ONE ops batch, so a gesture is one transaction and one revision in History, and every
 * entity patch carries the version it was rendered from (C7). The server sorts creates
 * before updates before deletes (§8.6 rule 7), so the order here is for the reader.
 *
 * A stub (`restricted`) is never written: the API would refuse it, and the viewer cannot
 * see what they would be moving.
 */
type Objects = SchemaModel['objects'];

export interface NewArea {
  readonly id: Id;
  readonly name: string;
  readonly color: string;
  readonly ordinal: number;
}

export function entityPatchOp(model: { objects: Objects }, entityId: Id, areaId: Id | null) {
  const entity = model.objects.entity[entityId];
  if (entity === undefined || entity.restricted === true || entity.areaId === areaId) return [];
  return [
    {
      op: 'update',
      type: 'entity',
      id: entity.id,
      expectedVersion: entity.version,
      patch: { areaId },
    } as const,
  ];
}

/** `create area` plus `update entity { areaId }` per table. */
export function groupOps(model: { objects: Objects }, entityIds: readonly Id[], area: NewArea) {
  return [
    {
      op: 'create',
      type: 'area',
      object: { ...area, engineProps: {} },
    } as const,
    ...entityIds.flatMap((id) => entityPatchOp(model, id, area.id)),
  ];
}

/** Join a card, or leave every card with `areaId: null`. */
export function moveOps(model: { objects: Objects }, entityIds: readonly Id[], areaId: Id | null) {
  return entityIds.flatMap((id) => entityPatchOp(model, id, areaId));
}

/** `update entity { areaId: null }` per visible member, then `delete area`. */
export function ungroupOps(model: { objects: Objects }, area: Area) {
  const members = Object.values(model.objects.entity).filter((e) => e.areaId === area.id);
  return [
    ...members.flatMap((e) => entityPatchOp(model, e.id, null)),
    { op: 'delete', type: 'area', id: area.id, expectedVersion: area.version } as const,
  ];
}

export function updateAreaOp(area: Area, patch: { name: string } | { color: string }) {
  return {
    op: 'update',
    type: 'area',
    id: area.id,
    expectedVersion: area.version,
    patch,
  } as const;
}

export const nextOrdinal = (areas: readonly Area[]): number =>
  areas.reduce((max, a) => Math.max(max, a.ordinal + 1), 0);
