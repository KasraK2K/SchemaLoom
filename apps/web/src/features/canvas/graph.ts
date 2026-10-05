import type { EngineStaticFacet, ResolvedType } from '@schemaloom/engine-sdk/ui';
import {
  isForeignKeyField,
  isPrimaryKey,
  isUniqueField,
  type Area,
  type Entity,
  type Field,
  type Id,
  type Link,
  type ModelIndex,
  type SchemaModel,
} from '@schemaloom/schema-model';
import type { Edge, Node } from '@xyflow/react';
import type { CSSProperties } from 'react';
import type { FieldBadges, LinkStyle } from '@/engines';
import { areaBorderVar, areaColorVar } from './area-color';
import { areaNodeId, areaRect } from './area-card';
import { NODE_HANDLE, fieldHandleId, type HandleSide } from './handles';

/**
 * The model -> React Flow projection.
 *
 * Every derivation an engine renderer needs is computed HERE, once per model, and handed
 * over on `node.data` — which is what `EngineNodeProps` asks for in as many words: "Core
 * computes the derivation ONCE per entity and hands it over; without this the renderer
 * would re-derive it from the whole model on every canvas frame." PK/FK/unique are not
 * field flags (doc 04 §2.6); they come out of `Constraint` and `Link` through the model
 * index, so the truth stays in one place.
 *
 * What is deliberately NOT in `data`: `selected` (React Flow owns it) and `collapsed`
 * (the store owns it). Putting either here would rebuild every node on every click.
 */
export const ENTITY_NODE_TYPE = 'entity';
export const LINK_EDGE_TYPE = 'link';

export interface EntityNodeData extends Record<string, unknown> {
  readonly entity: Entity;
  /** ordered by `ordinal` (C11) by the model index, already redacted */
  readonly fields: readonly Field[];
  readonly badges: ReadonlyMap<Id, FieldBadges>;
  readonly resolvedTypes: ReadonlyMap<Id, ResolvedType>;
  readonly areaColor: string | null;
}

export type EntityNode = Node<EntityNodeData, typeof ENTITY_NODE_TYPE>;

export interface LinkEdgeData extends Record<string, unknown> {
  readonly link: Link;
  /** Appearance only — the RULES are `capabilities.linkKinds`, evaluated by `checkLink`. */
  readonly style: LinkStyle | null;
}

export type LinkEdge = Edge<LinkEdgeData, typeof LINK_EDGE_TYPE>;

const NO_BADGES: ReadonlyMap<Id, FieldBadges> = new Map();
const NO_TYPES: ReadonlyMap<Id, ResolvedType> = new Map();
const NO_FIELDS: readonly Field[] = [];

export function buildNodes(
  ix: ModelIndex,
  facet: EngineStaticFacet,
  areaColorById: ReadonlyMap<Id, string>,
  /** area -> token slot; a table in an area rings itself in that area's hue when selected */
  areaSlotById: ReadonlyMap<Id, number> = new Map(),
): EntityNode[] {
  const { model } = ix;
  const customTypes = Object.values(model.objects.customType);

  return Object.values(model.objects.entity).map((entity) => {
    // A stub carries no fields the viewer may see, and its `namespaceId` is the default
    // one (RECONCILIATION R-2). Deriving badges and types for it would be work that
    // produces nothing; skipping it also means no derivation can accidentally describe it.
    const stub = entity.restricted === true;
    const fields = stub ? NO_FIELDS : (ix.fieldsByEntity.get(entity.id) ?? NO_FIELDS);
    const namespaceName = model.objects.namespace[entity.namespaceId]?.name ?? null;

    return {
      id: entity.id,
      type: ENTITY_NODE_TYPE,
      position: entity.position,
      ...(entity.width === undefined ? {} : { width: entity.width }),
      ...(entity.height === undefined ? {} : { height: entity.height }),
      ...selectStyle(entity, areaSlotById),
      data: {
        entity,
        fields,
        badges: stub ? NO_BADGES : badgesOf(ix, fields),
        resolvedTypes: stub
          ? NO_TYPES
          : new Map(
              fields.map((field) => [
                field.id,
                facet.typeCatalog.resolve(field.type, { customTypes, namespaceName }),
              ]),
            ),
        areaColor: entity.areaId === null ? null : (areaColorById.get(entity.areaId) ?? null),
      },
    } satisfies EntityNode;
  });
}

export const AREA_NODE_TYPE = 'area';

export interface AreaNodeData extends Record<string, unknown> {
  readonly area: Area;
  readonly fill: string;
  readonly border: string;
  /** a dragged table is over this card and would join it on drop */
  readonly highlighted: boolean;
  readonly memberIds: readonly Id[];
}

export type AreaNode = Node<AreaNodeData, typeof AREA_NODE_TYPE>;

/**
 * The cards, derived from where the tables are NOW (docs/phase23/AREA-CARDS.md D2). Not
 * kept in state: a card has no position of its own, so it is rebuilt from the measured
 * table nodes on every render and can never disagree with them. A card none of whose
 * tables is measured yet, or that has no visible table, is not drawn.
 *
 * `selectable`/`draggable` off, so React Flow gives the wrapper `pointer-events: none` and
 * only the label (which opts back in) takes the pointer.
 */
export function buildAreaNodes(
  areas: readonly Area[],
  tables: readonly EntityNode[],
  slots: ReadonlyMap<Id, number>,
  highlighted: Id | null,
): AreaNode[] {
  return areas.flatMap((area) => {
    const members = tables.filter(
      (n) => n.data.entity.areaId === area.id && n.data.entity.restricted !== true,
    );
    const rect = areaRect(
      members.flatMap((n) => {
        const width = n.measured?.width ?? n.width;
        const height = n.measured?.height ?? n.height;
        return width === undefined || height === undefined
          ? []
          : [{ x: n.position.x, y: n.position.y, width, height }];
      }),
    );
    if (rect === null) return [];
    const slot = slots.get(area.id) ?? 0;
    return [
      {
        id: areaNodeId(area.id),
        type: AREA_NODE_TYPE,
        position: { x: rect.x, y: rect.y },
        width: rect.width,
        height: rect.height,
        // Cards are not state, so React Flow's own measurement of one has nowhere to go.
        // Without a size here `useNodesInitialized` stays false for as long as a card is
        // on the canvas, and the first placement of an import never runs.
        measured: { width: rect.width, height: rect.height },
        zIndex: -1,
        selectable: false,
        draggable: false,
        connectable: false,
        focusable: false,
        data: {
          area,
          fill: areaColorVar(slot),
          border: areaBorderVar(slot),
          highlighted: highlighted === area.id,
          memberIds: members.map((n) => n.id),
        },
      } satisfies AreaNode,
    ];
  });
}

/** `--sl-select` is the ring colour of a selected table; the renderers read it (themes.css). */
function selectStyle(entity: Entity, slots: ReadonlyMap<Id, number>) {
  const slot =
    entity.areaId === null || entity.restricted === true ? undefined : slots.get(entity.areaId);
  return slot === undefined
    ? {}
    : { style: { '--sl-select': `var(--area-hue-${String(slot + 1)})` } as CSSProperties };
}

function badgesOf(ix: ModelIndex, fields: readonly Field[]): ReadonlyMap<Id, FieldBadges> {
  return new Map(
    fields.map((field) => [
      field.id,
      {
        primaryKey: isPrimaryKey(ix, field.id),
        foreignKey: isForeignKeyField(ix, field.id),
        unique: isUniqueField(ix, field.id),
      },
    ]),
  );
}

/**
 * A link whose endpoint has no usable field id hangs off the card's node-level handle.
 * That covers an entity-level kind, a link drawn before its columns were chosen, and the
 * badge-redacted link whose endpoints `VisibilityFilter` cleared — which is the case that
 * must keep drawing, because a stub the viewer cannot see is only comprehensible as a box
 * something connects TO.
 */
export function buildEdges(
  model: SchemaModel,
  linkStyles: Readonly<Record<string, LinkStyle>> | undefined,
): LinkEdge[] {
  const entities = model.objects.entity;

  return Object.values(model.objects.link)
    .filter(
      (link) =>
        entities[link.from.entityId] !== undefined && entities[link.to.entityId] !== undefined,
    )
    .map((link) => ({
      id: link.id,
      type: LINK_EDGE_TYPE,
      source: link.from.entityId,
      target: link.to.entityId,
      sourceHandle: endpointHandle(model, link.from.entityId, link.from.fieldIds[0], 'source'),
      targetHandle: endpointHandle(model, link.to.entityId, link.to.fieldIds[0], 'target'),
      data: { link, style: linkStyles?.[link.kind] ?? null },
    }));
}

function endpointHandle(
  model: SchemaModel,
  entityId: Id,
  fieldId: Id | undefined,
  side: HandleSide,
): string {
  const usable =
    fieldId !== undefined &&
    model.objects.field[fieldId] !== undefined &&
    model.objects.entity[entityId]?.restricted !== true;
  return usable ? fieldHandleId(fieldId, side) : NODE_HANDLE[side];
}
