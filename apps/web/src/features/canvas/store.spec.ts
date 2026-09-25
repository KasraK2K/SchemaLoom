import { beforeEach, describe, expect, it } from 'vitest';
import { selectCanRedo, selectCanUndo, useCanvasStore } from './store';

const store = () => useCanvasStore.getState();

describe('canvas store', () => {
  beforeEach(() => {
    store().reset();
  });

  it('replaces the selection by default and extends on request', () => {
    store().select(['a', 'b']);
    expect([...store().selection].sort()).toEqual(['a', 'b']);
    store().select(['c']);
    expect([...store().selection]).toEqual(['c']);
    store().select(['d'], 'extend');
    expect([...store().selection].sort()).toEqual(['c', 'd']);
  });

  it('does not notify when the selection is unchanged', () => {
    store().select(['a']);
    const before = store().selection;
    store().select(['a']);
    // Identity, not equality: a new set here re-renders every mounted node, and
    // `onSelectionChange` fires on every pointer move of a lasso.
    expect(store().selection).toBe(before);
  });

  it('selecting a field narrows the selection to its entity', () => {
    store().select(['a', 'b']);
    store().selectField('a', 'f1');
    expect([...store().selection]).toEqual(['a']);
    expect(store().selectedFieldId).toBe('f1');
  });

  it('clears the field when the entity selection changes', () => {
    store().selectField('a', 'f1');
    store().select(['b']);
    expect(store().selectedFieldId).toBeNull();
  });

  it('toggles collapse per entity', () => {
    store().toggleCollapse('a');
    expect(store().collapsed.has('a')).toBe(true);
    store().toggleCollapse('a');
    expect(store().collapsed.has('a')).toBe(false);
  });

  it('undoes a drag to the position it started from', () => {
    store().recordMove([{ id: 'a', before: { x: 0, y: 0 }, after: { x: 64, y: 32 } }]);
    expect(selectCanUndo(store())).toBe(true);
    expect(store().undoMove()).toEqual([{ id: 'a', position: { x: 0, y: 0 } }]);
    expect(selectCanRedo(store())).toBe(true);
    expect(store().redoMove()).toEqual([{ id: 'a', position: { x: 64, y: 32 } }]);
  });

  it('treats a multi-card drag as ONE undo step', () => {
    store().recordMove([
      { id: 'a', before: { x: 0, y: 0 }, after: { x: 16, y: 0 } },
      { id: 'b', before: { x: 0, y: 0 }, after: { x: 32, y: 0 } },
    ]);
    expect(store().undoMove()).toHaveLength(2);
    expect(store().undoMove()).toBeNull();
  });

  it('records nothing for an empty batch', () => {
    store().recordMove([]);
    expect(selectCanUndo(store())).toBe(false);
  });

  it('returns null rather than an empty array when there is nothing to undo', () => {
    expect(store().undoMove()).toBeNull();
    expect(store().redoMove()).toBeNull();
  });

  it('reset clears selection, collapse and the undo stack', () => {
    store().select(['a']);
    store().toggleCollapse('a');
    store().recordMove([{ id: 'a', before: { x: 0, y: 0 }, after: { x: 1, y: 1 } }]);
    store().reset();
    expect(store().selection.size).toBe(0);
    expect(store().collapsed.size).toBe(0);
    expect(selectCanUndo(store())).toBe(false);
  });
});
