import { describe, expect, it } from 'vitest';
import {
  AREA_PADDING,
  areaIdOfNode,
  areaNodeId,
  areaRect,
  centreOf,
  hitArea,
  isAreaNodeId,
  nextAreaName,
  type Box,
} from './area-card';

const box = (x: number, y: number, width = 100, height = 50): Box => ({ x, y, width, height });

describe('areaRect', () => {
  it('is the bounding box of the members plus padding on every side', () => {
    const rect = areaRect([box(0, 0), box(300, 200, 100, 60)]);
    expect(rect).toEqual({
      x: -AREA_PADDING,
      y: -AREA_PADDING,
      width: 400 + 2 * AREA_PADDING,
      height: 260 + 2 * AREA_PADDING,
    });
  });

  it('wraps one table at its own size', () => {
    expect(areaRect([box(10, 20, 100, 50)])).toEqual({
      x: 10 - AREA_PADDING,
      y: 20 - AREA_PADDING,
      width: 100 + 2 * AREA_PADDING,
      height: 50 + 2 * AREA_PADDING,
    });
  });

  it('has none for an empty card, which is therefore not drawn', () => {
    expect(areaRect([])).toBeNull();
  });

  it('only stretches when a member is dragged out; it never forgets the member', () => {
    const before = areaRect([box(0, 0), box(150, 0)]);
    const after = areaRect([box(0, 0), box(900, 700)]);
    expect(after?.width).toBeGreaterThan(before?.width ?? 0);
    expect(after?.x).toBe(before?.x);
  });
});

describe('hitArea', () => {
  const rects = new Map<string, Box>([
    ['big', box(0, 0, 1000, 800)],
    ['small', box(100, 100, 200, 150)],
    ['far', box(2000, 2000, 100, 100)],
  ]);

  it('finds the card under the point', () => {
    expect(hitArea({ x: 2050, y: 2050 }, rects)).toBe('far');
  });

  it('prefers the smallest card when two contain the point', () => {
    expect(hitArea({ x: 150, y: 150 }, rects)).toBe('small');
  });

  it('misses empty canvas', () => {
    expect(hitArea({ x: 1500, y: 1500 }, rects)).toBeNull();
  });

  it('ignores the table’s own card, which stretches to follow it', () => {
    expect(hitArea({ x: 150, y: 150 }, rects, 'small')).toBe('big');
    expect(hitArea({ x: 2050, y: 2050 }, rects, 'far')).toBeNull();
  });

  it('counts the edge as inside', () => {
    expect(hitArea({ x: 0, y: 0 }, rects)).toBe('big');
  });

  it('hits by the centre of a dragged table', () => {
    const dragged = box(80, 80, 100, 50);
    expect(hitArea(centreOf(dragged), rects)).toBe('small');
    expect(hitArea(centreOf(box(-90, -40, 100, 50)), rects)).toBeNull();
  });
});

describe('nextAreaName', () => {
  it('starts at Area 1', () => {
    expect(nextAreaName([])).toBe('Area 1');
  });

  it('skips a name that is taken, whatever its case, because names are unique per project', () => {
    expect(nextAreaName([{ name: 'area 1' }, { name: 'Billing' }])).toBe('Area 3');
    expect(nextAreaName([{ name: 'Area 2' }])).toBe('Area 3');
  });
});

describe('card node ids', () => {
  it('cannot collide with a table id, and round-trip', () => {
    expect(isAreaNodeId(areaNodeId('abc'))).toBe(true);
    expect(isAreaNodeId('abc')).toBe(false);
    expect(areaIdOfNode(areaNodeId('abc'))).toBe('abc');
  });
});
