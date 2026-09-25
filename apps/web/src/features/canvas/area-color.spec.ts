import type { Area } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import { AREA_COLOR_COUNT, areaColorVar, areaColors } from './area-color';

const area = (id: string, ordinal: number): Area => ({
  id,
  name: id,
  version: 1,
  engineProps: {},
  color: 'indigo',
  ordinal,
  doc: null,
});

describe('area colours', () => {
  it('maps index to the semantic token, one-based', () => {
    expect(areaColorVar(0)).toBe('var(--color-area-1)');
    expect(areaColorVar(7)).toBe(`var(--color-area-${String(AREA_COLOR_COUNT)})`);
  });

  it('wraps round-robin past the eighth token', () => {
    expect(areaColorVar(8)).toBe(areaColorVar(0));
    expect(areaColorVar(9)).toBe(areaColorVar(1));
  });

  it('assigns by ordinal, not by insertion order', () => {
    const colors = areaColors([area('late', 2), area('first', 0), area('middle', 1)]);
    expect(colors.get('first')).toBe('var(--color-area-1)');
    expect(colors.get('middle')).toBe('var(--color-area-2)');
    expect(colors.get('late')).toBe('var(--color-area-3)');
  });

  it('is deterministic: the same areas in any order give the same colours', () => {
    const areas = [area('a', 0), area('b', 1), area('c', 2)];
    const forward = areaColors(areas);
    const backward = areaColors([...areas].reverse());
    for (const { id } of areas) expect(backward.get(id)).toBe(forward.get(id));
  });

  it('breaks an ordinal tie by id so the mapping never flips between renders', () => {
    const colors = areaColors([area('zzz', 0), area('aaa', 0)]);
    expect(colors.get('aaa')).toBe('var(--color-area-1)');
    expect(colors.get('zzz')).toBe('var(--color-area-2)');
  });
});
