import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, emptyHistory, record, redo, undo } from './history';

describe('undo / redo stack', () => {
  it('reports nothing to do when empty', () => {
    const history = emptyHistory<string>();
    expect(canUndo(history)).toBe(false);
    expect(canRedo(history)).toBe(false);
    expect(undo(history).entry).toBeUndefined();
    expect(redo(history).entry).toBeUndefined();
  });

  it('moves an entry from past to future and back', () => {
    const recorded = record(record(emptyHistory<string>(), 'one'), 'two');
    const undone = undo(recorded);
    expect(undone.entry).toBe('two');
    expect(undone.history.past).toEqual(['one']);

    const redone = redo(undone.history);
    expect(redone.entry).toBe('two');
    expect(redone.history.past).toEqual(['one', 'two']);
    expect(redone.history.future).toEqual([]);
  });

  it('undoes in reverse order', () => {
    const history = record(record(record(emptyHistory<string>(), 'a'), 'b'), 'c');
    const first = undo(history);
    const second = undo(first.history);
    expect([first.entry, second.entry]).toEqual(['c', 'b']);
  });

  it('drops the future when a new entry is recorded', () => {
    // The case a hand-rolled pair of arrays gets wrong: redo after a fresh edit must not
    // replay something that no longer follows from the current state.
    const undone = undo(record(record(emptyHistory<string>(), 'a'), 'b'));
    expect(undone.history.future).toEqual(['b']);
    const afterNewEdit = record(undone.history, 'c');
    expect(afterNewEdit.future).toEqual([]);
    expect(canRedo(afterNewEdit)).toBe(false);
  });

  it('keeps the newest entries when the limit is reached', () => {
    let history = emptyHistory<number>();
    for (let i = 0; i < 5; i += 1) history = record(history, i, 3);
    expect(history.past).toEqual([2, 3, 4]);
  });

  it('returns the same object when there is nothing to move', () => {
    const history = emptyHistory<string>();
    expect(undo(history).history).toBe(history);
    expect(redo(history).history).toBe(history);
  });
});
