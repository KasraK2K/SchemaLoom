import type { Area, Id, Point } from '@schemaloom/schema-model';

/**
 * The geometry and naming behind an area card (docs/phase23/AREA-CARDS.md D2/D3).
 *
 * A card has no stored rectangle: it is the bounding box of the tables that belong to it,
 * plus padding, recomputed from their measured sizes on every render. Membership is the
 * explicit `Entity.areaId`; pixels never change it, so a table dragged out of a card only
 * stretches the card.
 */
export const AREA_PADDING = 32;

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The card around `members`, or `null` for an empty card (which is not drawn). */
export function areaRect(members: readonly Box[], padding = AREA_PADDING): Box | null {
  if (members.length === 0) return null;
  const left = Math.min(...members.map((m) => m.x));
  const top = Math.min(...members.map((m) => m.y));
  const right = Math.max(...members.map((m) => m.x + m.width));
  const bottom = Math.max(...members.map((m) => m.y + m.height));
  return {
    x: left - padding,
    y: top - padding,
    width: right - left + 2 * padding,
    height: bottom - top + 2 * padding,
  };
}

export const centreOf = (box: Box): Point => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});

const contains = (box: Box, point: Point): boolean =>
  point.x >= box.x &&
  point.x <= box.x + box.width &&
  point.y >= box.y &&
  point.y <= box.y + box.height;

/**
 * The card a dragged table would join: the smallest one under `point`, so a card drawn
 * inside the bounding box of a bigger one still wins. `exclude` is the table's own card,
 * which stretches to follow it and would always match.
 */
export function hitArea(
  point: Point,
  rects: ReadonlyMap<Id, Box>,
  exclude: Id | null = null,
): Id | null {
  let best: { id: Id; size: number } | null = null;
  for (const [id, box] of rects) {
    if (id === exclude || !contains(box, point)) continue;
    const size = box.width * box.height;
    if (best === null || size < best.size) best = { id, size };
  }
  return best?.id ?? null;
}

/** "Area 1" until renamed; the first number whose name is free (names are unique per project). */
export function nextAreaName(areas: readonly Pick<Area, 'name'>[]): string {
  const taken = new Set(areas.map((a) => a.name.toLowerCase()));
  for (let n = areas.length + 1; ; n++) {
    const name = `Area ${String(n)}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** React Flow node ids for cards are prefixed so they can never collide with a table's. */
export const AREA_NODE_PREFIX = 'area:';
export const areaNodeId = (areaId: Id): Id => `${AREA_NODE_PREFIX}${areaId}`;
export const isAreaNodeId = (id: string): boolean => id.startsWith(AREA_NODE_PREFIX);
export const areaIdOfNode = (id: string): Id => id.slice(AREA_NODE_PREFIX.length);
