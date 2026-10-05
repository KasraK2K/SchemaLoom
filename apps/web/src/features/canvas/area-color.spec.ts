import type { Area } from '@schemaloom/schema-model';
import { describe, expect, it } from 'vitest';
import {
  AREA_COLOR_COUNT,
  areaBorderVar,
  areaColorVar,
  areaColors,
  areaSlots,
  areaToken,
  nextAreaToken,
  slotOf,
} from './area-color';

const area = (id: string, ordinal: number, color = 'unknown'): Area => ({
  id,
  name: id,
  version: 1,
  engineProps: {},
  color,
  ordinal,
  doc: null,
});

describe('area colours', () => {
  it('maps index to the semantic token, one-based', () => {
    expect(areaColorVar(0)).toBe('var(--color-area-1)');
    expect(areaColorVar(15)).toBe(`var(--color-area-${String(AREA_COLOR_COUNT)})`);
    expect(AREA_COLOR_COUNT).toBe(16);
    expect(areaBorderVar(2)).toBe('var(--color-area-3-border)');
  });

  it('wraps round-robin past the sixteenth token', () => {
    expect(areaColorVar(16)).toBe(areaColorVar(0));
    expect(areaColorVar(17)).toBe(areaColorVar(1));
  });

  describe('the stored value', () => {
    it('reads a token name', () => {
      expect(slotOf('area-1')).toBe(0);
      expect(slotOf('area-8')).toBe(7);
      expect(slotOf('area-9')).toBe(8);
      expect(slotOf('area-16')).toBe(15);
      expect(areaToken(2)).toBe('area-3');
    });

    it('reads the Radix names written before cards existed, as the token of that hue', () => {
      expect(slotOf('indigo')).toBe(5);
      expect(slotOf('amber')).toBe(2);
      expect(slotOf('Tomato')).toBe(3);
    });

    it('reads nothing else', () => {
      expect(slotOf('area-17')).toBeNull();
      expect(slotOf('area-0')).toBeNull();
      expect(slotOf('#ff0000')).toBeNull();
      expect(slotOf('')).toBeNull();
    });

    it('wins over position: a card keeps its colour when its ordinal changes', () => {
      const colors = areaColors([area('a', 0, 'area-5'), area('b', 1, 'area-2')]);
      expect(colors.get('a')).toBe('var(--color-area-5)');
      expect(colors.get('b')).toBe('var(--color-area-2)');
    });

    it('maps an old Radix name to its slot', () => {
      expect(areaSlots([area('a', 0, 'indigo')]).get('a')).toBe(5);
    });
  });

  describe('the fallback for an unknown value', () => {
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

  describe('the next colour for a new area', () => {
    it('is the first token when there are no areas', () => {
      expect(nextAreaToken([])).toBe('area-1');
    });

    it('skips tokens in use', () => {
      expect(nextAreaToken([area('a', 0, 'area-1'), area('b', 1, 'area-2')])).toBe('area-3');
    });

    it('takes the least used one once all sixteen are taken', () => {
      const all = Array.from({ length: AREA_COLOR_COUNT }, (_, i) =>
        area(`a${String(i)}`, i, areaToken(i)),
      );
      expect(nextAreaToken(all)).toBe('area-1');
      expect(nextAreaToken(all.filter((a) => a.id !== 'a11'))).toBe('area-12');
    });
  });
});
