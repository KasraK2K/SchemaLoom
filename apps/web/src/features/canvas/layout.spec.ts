import { describe, expect, it } from 'vitest';
import { unstack } from './layout';

const node = (id: string, x: number, y: number) => ({ id, width: 200, height: 100, position: { x, y } });

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
