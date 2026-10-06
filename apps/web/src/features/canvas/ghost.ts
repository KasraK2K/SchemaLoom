import type { Id, Point } from '@schemaloom/schema-model';
import type { Edge, Node } from '@xyflow/react';
import type { DraftPreview } from '@/features/ai/ai-api';
import { AREA_PADDING, areaRect, type Box } from './area-card';
import { NODE_HANDLE } from './handles';
import { autoLayout, snap } from './layout';

/**
 * Phase 22b — an AI draft drawn on the canvas before anything is written
 * (docs/phase22/DRAFT-PREVIEW.md). Ghosts are web state only: derived from the draft's
 * `preview` and the positions placed once per draft, never in the model.
 */
export const GHOST_NODE_TYPE = 'ghost';
export const GHOST_AREA_NODE_TYPE = 'ghostArea';
export const GHOST_LINK_EDGE_TYPE = 'ghostLink';

export type GhostTable = DraftPreview['tables'][number];

/** Fixed pixel sizes (ghost-node.tsx draws to them), so placement needs no measuring. */
export const GHOST_WIDTH = 224;
export const GHOST_HEADER = 36;
export const GHOST_ROW = 24;
export const ghostHeight = (table: GhostTable): number =>
  GHOST_HEADER + Math.max(table.columns.length, 1) * GHOST_ROW + 8;

const GHOST_PREFIX = 'ghost:';
export const ghostNodeId = (key: string): Id => `${GHOST_PREFIX}${key}`;
export const isGhostNodeId = (id: string): boolean => id.startsWith(GHOST_PREFIX);
export const GHOST_AREA_ID = `${GHOST_PREFIX}area`;

const GAP = 96;

/**
 * Where the ghosts go (D4): the draft's own tables laid out by ELK, then the block put in
 * free space to the right of the tables it builds on (the focus, else the tables it links
 * to, else everything). Existing tables never move; the block steps right past any it would
 * overlap.
 *
 * ponytail: ELK lays out the ghosts alone and the block is placed beside its anchors, not one
 * ELK run with the existing tables pinned (layered has no pinned nodes). A link into the
 * middle of a large project can land far from its anchor; pin through ELK `interactive` mode
 * if that shows up.
 */
export async function placeGhosts(
  preview: DraftPreview,
  existing: readonly (Box & { readonly id: Id })[],
  focus: readonly Id[],
): Promise<Map<string, Point>> {
  const keys = new Set(preview.tables.map((t) => t.key));
  const laid = await autoLayout(
    preview.tables.map((t) => ({ id: t.key, width: GHOST_WIDTH, height: ghostHeight(t) })),
    preview.links
      .filter((l) => keys.has(l.from) && keys.has(l.to))
      .map((l, i) => ({ id: String(i), source: l.from, target: l.to })),
  );
  const boxes = preview.tables.flatMap((t) => {
    const at = laid.get(t.key);
    return at === undefined ? [] : [{ ...at, width: GHOST_WIDTH, height: ghostHeight(t) }];
  });
  // The card around the ghosts (and its label) must clear the tables too.
  const block = areaRect(boxes, AREA_PADDING);
  if (block === null) return new Map();

  const linked = new Set(preview.links.flatMap((l) => [l.from, l.to]));
  const pick = (ids: ReadonlySet<Id>) => existing.filter((b) => ids.has(b.id));
  const anchors = [pick(new Set(focus)), pick(linked), existing].find((a) => a.length > 0) ?? [];
  const anchor = areaRect(anchors, 0);
  let x = anchor === null ? 0 : anchor.x + anchor.width + GAP;
  const y = anchor === null ? 0 : anchor.y;

  const overlaps = (b: Box) =>
    b.x < x + block.width + GAP / 2 &&
    x - GAP / 2 < b.x + b.width &&
    b.y < y + block.height + GAP / 2 &&
    y - GAP / 2 < b.y + b.height;
  for (let hit = existing.filter(overlaps); hit.length > 0; hit = existing.filter(overlaps))
    x = Math.max(...hit.map((b) => b.x + b.width)) + GAP;

  const dx = x - block.x;
  const dy = y - block.y;
  return new Map(
    preview.tables.flatMap((t) => {
      const at = laid.get(t.key);
      return at === undefined ? [] : [[t.key, { x: snap(at.x + dx), y: snap(at.y + dy) }]];
    }),
  );
}

export interface GhostNodeData extends Record<string, unknown> {
  readonly table: GhostTable;
}
export type GhostNode = Node<GhostNodeData, typeof GHOST_NODE_TYPE>;

export interface GhostAreaNodeData extends Record<string, unknown> {
  readonly name: string;
}
export type GhostAreaNode = Node<GhostAreaNodeData, typeof GHOST_AREA_NODE_TYPE>;

export type GhostLinkEdge = Edge<Record<string, never>, typeof GHOST_LINK_EDGE_TYPE>;

const inert = {
  selectable: false,
  draggable: false,
  connectable: false,
  focusable: false,
} as const;

/** The ghost tables, and their card when the draft names an area (Q2). */
export function buildGhostNodes(
  preview: DraftPreview,
  positions: ReadonlyMap<string, Point>,
): (GhostNode | GhostAreaNode)[] {
  const tables = preview.tables.flatMap((table): GhostNode[] => {
    const position = positions.get(table.key);
    if (position === undefined) return [];
    const size = { width: GHOST_WIDTH, height: ghostHeight(table) };
    return [
      {
        id: ghostNodeId(table.key),
        type: GHOST_NODE_TYPE,
        position,
        ...size,
        // Not state, so React Flow's measurement has nowhere to go (as for area cards).
        measured: size,
        ...inert,
        data: { table },
      },
    ];
  });
  const rect =
    preview.area === null
      ? null
      : areaRect(tables.map((n) => ({ ...n.position, width: GHOST_WIDTH, height: n.height ?? 0 })));
  if (rect === null || preview.area === null) return tables;
  const size = { width: rect.width, height: rect.height };
  return [
    {
      id: GHOST_AREA_ID,
      type: GHOST_AREA_NODE_TYPE,
      position: { x: rect.x, y: rect.y },
      ...size,
      measured: size,
      zIndex: -1,
      ...inert,
      data: { name: preview.area },
    },
    ...tables,
  ];
}

/** Dashed lines between ghosts, and from ghosts to the existing tables they reference. */
export function buildGhostEdges(preview: DraftPreview, existing: ReadonlySet<Id>): GhostLinkEdge[] {
  const keys = new Set(preview.tables.map((t) => t.key));
  const end = (id: string): Id | null =>
    keys.has(id) ? ghostNodeId(id) : existing.has(id) ? id : null;
  return preview.links.flatMap((l, i) => {
    // Ghosts sit right of the tables they reference (`placeGhosts`), so that link is drawn
    // from the existing table's right side; drawn the link's way it would cross the ghost.
    // The line carries no direction marker.
    const flip = keys.has(l.from) && !keys.has(l.to);
    const [source, target] = flip ? [end(l.to), end(l.from)] : [end(l.from), end(l.to)];
    return source === null || target === null
      ? []
      : [
          {
            id: `${GHOST_PREFIX}link:${String(i)}`,
            type: GHOST_LINK_EDGE_TYPE,
            source,
            target,
            sourceHandle: NODE_HANDLE.source,
            targetHandle: NODE_HANDLE.target,
            selectable: false,
            focusable: false,
            data: {},
          },
        ];
  });
}
