import { describe, expect, it } from 'vitest';
import { areaRect, type Box } from './area-card';
import { autoLayout, unstack, type LayoutNode } from './layout';

const node = (id: string, x: number, y: number) => ({
  id,
  width: 200,
  height: 100,
  position: { x, y },
});

describe('unstack', () => {
  it('asks for a full layout when every table is piled at the origin', () => {
    expect(unstack([node('a', 0, 0), node('b', 0, 0)])).toBe('all');
  });

  it('leaves a single table at the origin alone', () => {
    expect(unstack([node('a', 0, 0), node('b', 400, 0)])).toEqual(new Map());
  });

  it('moves only the pile, into a grid below the laid-out tables', () => {
    const moved = unstack([node('a', 96, 32), node('b', 0, 0), node('c', 0, 0)]);
    expect(moved).toEqual(
      new Map([
        ['b', { x: 96, y: 176 }],
        ['c', { x: 352, y: 176 }],
      ]),
    );
  });
});

describe('autoLayout with area cards (ELK compound nodes)', () => {
  const table = (id: string, areaId: string | null = null): LayoutNode => ({
    id,
    width: 220,
    height: 160,
    areaId,
  });

  /** Two cards of three tables, two loose tables, links inside and across the cards. */
  const nodes = [
    table('books', 'library'),
    table('authors', 'library'),
    table('shelves', 'library'),
    table('orders', 'shop'),
    table('items', 'shop'),
    table('carts', 'shop'),
    table('audit'),
    table('settings'),
  ];
  const edges = [
    { id: 'e1', source: 'books', target: 'authors' },
    { id: 'e2', source: 'shelves', target: 'books' },
    { id: 'e3', source: 'items', target: 'orders' },
    { id: 'e4', source: 'carts', target: 'orders' },
    { id: 'e5', source: 'items', target: 'books' }, // across two cards
    { id: 'e6', source: 'audit', target: 'orders' }, // loose table into a card
  ];

  const boxOf = (positions: Map<string, { x: number; y: number }>, id: string): Box => {
    const at = positions.get(id);
    if (at === undefined) throw new Error(`no position for ${id}`);
    return { ...at, width: 220, height: 160 };
  };
  const overlaps = (a: Box, b: Box): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  it('positions every table, and no card id leaks out as a table', async () => {
    const positions = await autoLayout(nodes, edges);
    expect([...positions.keys()].sort()).toEqual(nodes.map((n) => n.id).sort());
  });

  it('keeps each card’s tables together: no other table lands inside the card around them', async () => {
    const positions = await autoLayout(nodes, edges);
    for (const area of ['library', 'shop']) {
      const members = nodes.filter((n) => n.areaId === area).map((n) => boxOf(positions, n.id));
      const card = areaRect(members);
      if (card === null) throw new Error('empty card');
      for (const other of nodes.filter((n) => n.areaId !== area)) {
        expect(overlaps(card, boxOf(positions, other.id)), `${other.id} inside ${area}`).toBe(
          false,
        );
      }
    }
  });

  it('places the two cards apart, like two big tables', async () => {
    const positions = await autoLayout(nodes, edges);
    const card = (area: string) =>
      areaRect(nodes.filter((n) => n.areaId === area).map((n) => boxOf(positions, n.id)));
    const library = card('library');
    const shop = card('shop');
    if (library === null || shop === null) throw new Error('empty card');
    expect(overlaps(library, shop)).toBe(false);
  });

  // Absolute, not offsets inside the card: offsets would put both cards' tables near the
  // origin, on top of each other and of the loose tables, which the three tests above forbid.
  it('puts every table on the canvas grid, the ones inside a card included', async () => {
    const positions = await autoLayout(nodes, edges);
    for (const { x, y } of positions.values()) {
      expect(x % 16).toBe(0);
      expect(y % 16).toBe(0);
    }
  });

  it('does not stack unlinked tables in one column, with or without a card', async () => {
    // A database import often has no links at all. One ELK pass over a compound hierarchy
    // turned that into a single column thousands of pixels tall.
    const unlinked = [
      ...Array.from({ length: 9 }, (_, i) => table(`t${String(i)}`)),
      table('a', 'card'),
      table('b', 'card'),
      table('c', 'card'),
    ];
    const positions = await autoLayout(unlinked, []);
    const xs = new Set([...positions.values()].map((p) => p.x));
    expect(xs.size).toBeGreaterThan(2);
    const ys = [...positions.values()].map((p) => p.y);
    const height = Math.max(...ys) - Math.min(...ys);
    expect(height).toBeLessThan(unlinked.length * 160);
  });

  it('lays out without cards exactly as before', async () => {
    const positions = await autoLayout(
      [table('a'), table('b')],
      [{ id: 'e', source: 'a', target: 'b' }],
    );
    const a = positions.get('a');
    const b = positions.get('b');
    expect(a).toBeDefined();
    expect((b?.x ?? 0) > (a?.x ?? 0)).toBe(true);
  });

  it('survives an edge to a table that is not laid out', async () => {
    const positions = await autoLayout(
      [table('a', 'card'), table('b', 'card')],
      [{ id: 'e', source: 'a', target: 'ghost' }],
    );
    expect(positions.size).toBe(2);
  });
});
