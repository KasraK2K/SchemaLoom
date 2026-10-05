import type { Id, Point } from '@schemaloom/schema-model';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { AREA_PADDING, areaIdOfNode, areaNodeId, isAreaNodeId } from './area-card';

/**
 * Auto-layout with elkjs (§6.1).
 *
 * Imported dynamically. ELK is a compiled-to-JS Java layout engine and the single largest
 * thing this route could load; a user who never presses "auto layout" should not download
 * it, and the import sits behind one user gesture.
 *
 * `layered` with `RIGHT` direction because an ER diagram reads as a dependency graph:
 * children point at parents, so laying it out along the link direction puts referenced
 * tables downstream of the tables that reference them.
 *
 * The result is snapped to the canvas grid, so a laid-out diagram and a hand-dragged card
 * sit on the same lattice.
 */
export interface LayoutNode {
  readonly id: Id;
  readonly width: number;
  readonly height: number;
  /** The area card the table belongs to: its tables are laid out inside it as a unit. */
  readonly areaId?: Id | null;
}

export interface LayoutEdge {
  readonly id: string;
  readonly source: Id;
  readonly target: Id;
}

export const GRID_SIZE = 16;

export const snap = (value: number): number => Math.round(value / GRID_SIZE) * GRID_SIZE;

const LAYERED = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.layered.spacing.nodeNodeBetweenLayers': '96',
  'elk.spacing.nodeNode': '48',
  'elk.edgeRouting': 'POLYLINE',
};

/**
 * Two levels, one ELK run each (docs/phase23/AREA-CARDS.md D4):
 *
 * 1. every card's tables are laid out on their own, which gives the card a size;
 * 2. the cards, now fixed-size boxes, are laid out with the loose tables, a link into a card
 *    counting as a link to the card.
 *
 * Not one run over a compound hierarchy (`INCLUDE_CHILDREN`): ELK then stops splitting the
 * graph into connected components and packing them side by side, so a project of tables that
 * are not linked to each other (common after a database import) came out as one column
 * thousands of pixels tall.
 */
export async function autoLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Promise<Map<Id, Point>> {
  if (nodes.length === 0) return new Map();

  const { default: Elk } = await import('elkjs/lib/elk.bundled.js');
  const elk = new Elk();
  const known = new Set(nodes.map((node) => node.id));
  // An edge whose endpoint is not laid out would make ELK throw and lose the whole
  // layout, so every pair is filtered against the node set rather than trusted.
  const usable = edges.filter(({ source, target }) => known.has(source) && known.has(target));
  const leaf = (node: LayoutNode) => ({ id: node.id, width: node.width, height: node.height });
  const link = (edge: LayoutEdge, source: Id, target: Id) => ({
    id: edge.id,
    sources: [source],
    targets: [target],
  });
  const pad = String(AREA_PADDING);

  const cards = new Map<Id, LayoutNode[]>();
  const loose: LayoutNode[] = [];
  for (const node of nodes) {
    if (node.areaId == null) loose.push(node);
    else cards.set(node.areaId, [...(cards.get(node.areaId) ?? []), node]);
  }

  // Level 1: inside each card. Tables sit at their offset from the card's corner, which
  // already includes the padding, so the card drawn around them is the box ELK reports.
  const inner = new Map<Id, { width: number; height: number; at: Map<Id, Point> }>();
  const cardOf = new Map<Id, Id>();
  for (const [areaId, members] of cards) {
    const ids = new Set(members.map((m) => m.id));
    for (const id of ids) cardOf.set(id, areaId);
    const laid: ElkNode = await elk.layout({
      id: areaNodeId(areaId),
      layoutOptions: {
        ...LAYERED,
        'elk.padding': `[top=${pad},left=${pad},bottom=${pad},right=${pad}]`,
      },
      children: members.map(leaf),
      edges: usable
        .filter(({ source, target }) => ids.has(source) && ids.has(target))
        .map((edge) => link(edge, edge.source, edge.target)),
    });
    inner.set(areaId, {
      width: laid.width ?? 0,
      height: laid.height ?? 0,
      at: new Map((laid.children ?? []).map((c) => [c.id, { x: c.x ?? 0, y: c.y ?? 0 }])),
    });
  }

  // Level 2: the cards and the loose tables.
  const top = (id: Id): Id => {
    const areaId = cardOf.get(id);
    return areaId === undefined ? id : areaNodeId(areaId);
  };
  const seen = new Set<string>();
  const outer = await elk.layout({
    id: 'root',
    layoutOptions: LAYERED,
    children: [
      ...loose.map(leaf),
      ...[...inner].map(([areaId, box]) => ({
        id: areaNodeId(areaId),
        width: box.width,
        height: box.height,
      })),
    ],
    edges: usable.flatMap((edge) => {
      const source = top(edge.source);
      const target = top(edge.target);
      const key = `${source}>${target}`;
      if (source === target || seen.has(key)) return [];
      seen.add(key);
      return [link(edge, source, target)];
    }),
  });

  const positions = new Map<Id, Point>();
  for (const child of outer.children ?? []) {
    const x = child.x ?? 0;
    const y = child.y ?? 0;
    if (!isAreaNodeId(child.id)) {
      positions.set(child.id, { x: snap(x), y: snap(y) });
      continue;
    }
    for (const [id, at] of inner.get(areaIdOfNode(child.id))?.at ?? [])
      positions.set(id, { x: snap(x + at.x), y: snap(y + at.y) });
  }
  return positions;
}

const GAP = 48;
const COLUMNS = 4;

/**
 * An import merged into a laid-out project adds its new tables at the origin (the importer
 * leaves layout to the canvas). Re-laying out everything would throw away the user's
 * arrangement, so only the pile is moved: into a grid below everything else.
 *
 * @returns `'all'` when every node is in the pile (a fresh import — lay out the lot),
 *   otherwise the new positions of the piled nodes; empty when there is no pile.
 */
export function unstack(
  nodes: readonly (LayoutNode & { readonly position: Point })[],
): 'all' | Map<Id, Point> {
  const pile = nodes.filter((n) => n.position.x === 0 && n.position.y === 0);
  if (pile.length < 2) return new Map();
  if (pile.length === nodes.length) return 'all';

  const placed = nodes.filter((n) => !pile.includes(n));
  const left = Math.min(...placed.map((n) => n.position.x));
  const top = Math.max(...placed.map((n) => n.position.y + n.height)) + GAP;
  const cell = Math.max(...pile.map((n) => n.width)) + GAP;
  const row = Math.max(...pile.map((n) => n.height)) + GAP;
  return new Map(
    pile.map((n, i) => [
      n.id,
      { x: snap(left + (i % COLUMNS) * cell), y: snap(top + Math.floor(i / COLUMNS) * row) },
    ]),
  );
}
