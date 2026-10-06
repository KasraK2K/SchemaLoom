import { describe, expect, it } from 'vitest';
import type { DraftPreview } from '@/features/ai/ai-api';
import {
  GHOST_AREA_ID,
  GHOST_WIDTH,
  buildGhostEdges,
  buildGhostNodes,
  ghostHeight,
  ghostNodeId,
  placeGhosts,
} from './ghost';

const table = (key: string, columns = 2): DraftPreview['tables'][number] => ({
  key,
  name: key,
  columns: Array.from({ length: columns }, (_, i) => ({
    name: `c${String(i)}`,
    type: 'text',
    pk: i === 0,
  })),
});

const preview = (over: Partial<DraftPreview> = {}): DraftPreview => ({
  tables: [table('invoices'), table('lines', 4)],
  addedColumns: [],
  links: [
    { from: 'lines', to: 'invoices' },
    { from: 'invoices', to: 'customers' },
  ],
  area: null,
  ...over,
});

const box = (id: string, x: number, y: number, width = 220, height = 160) => ({
  id,
  x,
  y,
  width,
  height,
});

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('placeGhosts (22b D4)', () => {
  it('places every ghost beside the table it links to, on the grid, overlapping nothing', async () => {
    const existing = [
      box('customers', 0, 0),
      box('orders', 400, 0),
      // In the way of the first spot right of `customers`.
      box('products', 300, 40),
    ];
    const at = await placeGhosts(preview(), existing, []);
    expect([...at.keys()].sort()).toEqual(['invoices', 'lines']);
    const ghosts = preview().tables.map((t) => ({
      ...(at.get(t.key) ?? { x: NaN, y: NaN }),
      width: GHOST_WIDTH,
      height: ghostHeight(t),
    }));
    for (const g of ghosts) {
      expect(g.x % 16).toBe(0);
      expect(g.y % 16).toBe(0);
      for (const e of existing) expect(overlaps(g, e)).toBe(false);
    }
    // Right of the anchor, not somewhere far below.
    expect(Math.min(...ghosts.map((g) => g.x))).toBeGreaterThan(220);
    expect(Math.min(...ghosts.map((g) => g.y))).toBeLessThan(160);
  });

  it('the focus wins over linked tables as the anchor', async () => {
    const existing = [box('customers', 0, 0), box('far', 0, 2000)];
    const at = await placeGhosts(preview(), existing, ['far']);
    expect(Math.min(...[...at.values()].map((p) => p.y))).toBeGreaterThanOrEqual(1900);
  });

  it('an empty canvas places the draft near the origin', async () => {
    const at = await placeGhosts(preview({ links: [] }), [], []);
    expect(at.size).toBe(2);
  });
});

describe('ghost nodes and edges', () => {
  const positions = new Map([
    ['invoices', { x: 512, y: 0 }],
    ['lines', { x: 832, y: 0 }],
  ]);

  it('links join ghosts to ghosts and existing tables (from their right side); unknown ends drop', () => {
    const edges = buildGhostEdges(
      preview({ links: [...preview().links, { from: 'lines', to: 'gone' }] }),
      new Set(['customers']),
    );
    expect(edges.map((e) => [e.source, e.target])).toEqual([
      [ghostNodeId('lines'), ghostNodeId('invoices')],
      ['customers', ghostNodeId('invoices')],
    ]);
  });

  it('a draft with an area gets a ghost card around its tables', () => {
    expect(buildGhostNodes(preview(), positions).map((n) => n.id)).not.toContain(GHOST_AREA_ID);
    const nodes = buildGhostNodes(preview({ area: 'Billing' }), positions);
    const card = nodes.find((n) => n.id === GHOST_AREA_ID);
    expect(card?.data).toEqual({ name: 'Billing' });
    expect(card?.position.x).toBeLessThan(512);
    expect((card?.position.x ?? 0) + (card?.width ?? 0)).toBeGreaterThan(832 + GHOST_WIDTH);
  });
});
