import type { Id, Point } from '@schemaloom/schema-model';

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
}

export interface LayoutEdge {
  readonly id: string;
  readonly source: Id;
  readonly target: Id;
}

export const GRID_SIZE = 16;

const snap = (value: number): number => Math.round(value / GRID_SIZE) * GRID_SIZE;

export async function autoLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Promise<Map<Id, Point>> {
  if (nodes.length === 0) return new Map();

  const { default: Elk } = await import('elkjs/lib/elk.bundled.js');
  const elk = new Elk();
  const known = new Set(nodes.map((node) => node.id));

  const laid = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '96',
      'elk.spacing.nodeNode': '48',
      'elk.edgeRouting': 'POLYLINE',
    },
    children: nodes.map((node) => ({ id: node.id, width: node.width, height: node.height })),
    // An edge whose endpoint is not laid out would make ELK throw and lose the whole
    // layout, so the pair is filtered against the node set rather than trusted.
    edges: edges
      .filter(({ source, target }) => known.has(source) && known.has(target))
      .map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });

  const positions = new Map<Id, Point>();
  for (const child of laid.children ?? []) {
    if (child.x === undefined || child.y === undefined) continue;
    positions.set(child.id, { x: snap(child.x), y: snap(child.y) });
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
