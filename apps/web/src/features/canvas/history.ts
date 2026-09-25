/**
 * Undo / redo, as a pure past/future pair.
 *
 * Generic over the entry type because the canvas records geometry today and will record
 * schema ops the day the ops mutation lands, and neither should own the stack. An entry
 * is whatever is needed to go BOTH ways — the caller decides its shape; this file only
 * moves entries between the two lists.
 *
 * `record()` clears the future, which is the whole reason this is not two arrays managed
 * inline: forgetting that one line is how a redo ends up replaying an edit that no longer
 * makes sense against the current state.
 */
export interface History<T> {
  readonly past: readonly T[];
  readonly future: readonly T[];
}

/** A drag at a time, so ~100 gestures. Unbounded is a memory leak on a long session. */
export const HISTORY_LIMIT = 100;

export function emptyHistory<T>(): History<T> {
  return { past: [], future: [] };
}

export function record<T>(history: History<T>, entry: T, limit = HISTORY_LIMIT): History<T> {
  const past = [...history.past, entry];
  return { past: past.slice(Math.max(0, past.length - limit)), future: [] };
}

export interface HistoryStep<T> {
  readonly history: History<T>;
  /** undefined when there was nothing to move — the caller does nothing. */
  readonly entry: T | undefined;
}

export function undo<T>(history: History<T>): HistoryStep<T> {
  const entry = history.past.at(-1);
  if (entry === undefined) return { history, entry: undefined };
  return {
    history: { past: history.past.slice(0, -1), future: [entry, ...history.future] },
    entry,
  };
}

export function redo<T>(history: History<T>): HistoryStep<T> {
  const entry = history.future.at(0);
  if (entry === undefined) return { history, entry: undefined };
  return {
    history: { past: [...history.past, entry], future: history.future.slice(1) },
    entry,
  };
}

export const canUndo = (history: History<unknown>): boolean => history.past.length > 0;
export const canRedo = (history: History<unknown>): boolean => history.future.length > 0;
