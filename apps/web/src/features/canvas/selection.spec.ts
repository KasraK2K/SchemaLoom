import { describe, expect, it } from 'vitest';
import {
  EMPTY_SELECTION,
  applySelect,
  extendSelection,
  sameSelection,
  selectOnly,
  toggleSelection,
} from './selection';

describe('selection reducer', () => {
  it('replaces the whole selection', () => {
    expect([...applySelect(selectOnly(['a', 'b']), ['c'], 'replace')]).toEqual(['c']);
  });

  it('toggles a selected id out and an unselected id in', () => {
    const first = toggleSelection(EMPTY_SELECTION, 'a');
    expect(first.has('a')).toBe(true);
    expect(toggleSelection(first, 'a').has('a')).toBe(false);
  });

  it('extends without dropping what was already selected', () => {
    expect([...extendSelection(selectOnly(['a']), ['b', 'a'])].sort()).toEqual(['a', 'b']);
  });

  it('toggles every id of a multi-id gesture', () => {
    // Shift-clicking a box that overlaps one selected and one unselected node.
    const next = applySelect(selectOnly(['a']), ['a', 'b'], 'toggle');
    expect([...next]).toEqual(['b']);
  });

  it('never mutates the set it was given', () => {
    const before = selectOnly(['a']);
    toggleSelection(before, 'b');
    extendSelection(before, ['c']);
    expect([...before]).toEqual(['a']);
  });

  it('compares by membership, so a rebuilt set is still the same selection', () => {
    expect(sameSelection(selectOnly(['a', 'b']), selectOnly(['b', 'a']))).toBe(true);
    expect(sameSelection(selectOnly(['a']), selectOnly(['a', 'b']))).toBe(false);
    expect(sameSelection(EMPTY_SELECTION, EMPTY_SELECTION)).toBe(true);
  });
});
