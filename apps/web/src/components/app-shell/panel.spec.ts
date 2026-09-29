import { describe, expect, it } from 'vitest';
import { clampWidth, dragWidth } from './panel';

const BOUNDS = { defaultWidth: 320, min: 260, max: 720 };

describe('side panel width', () => {
  it('a left panel grows as the pointer moves right, a right panel as it moves left', () => {
    expect(dragWidth('left', 300, 100, 150, BOUNDS)).toBe(350);
    expect(dragWidth('right', 300, 100, 150, BOUNDS)).toBe(260);
    expect(dragWidth('right', 300, 500, 400, BOUNDS)).toBe(400);
  });

  it('never leaves the bounds', () => {
    expect(dragWidth('left', 300, 0, 10_000, BOUNDS)).toBe(720);
    expect(dragWidth('right', 300, 0, 10_000, BOUNDS)).toBe(260);
    expect(clampWidth(Number.NaN, BOUNDS)).toBeNaN();
    expect(clampWidth(333.6, BOUNDS)).toBe(334);
  });
});
