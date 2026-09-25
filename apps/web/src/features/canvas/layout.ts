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
