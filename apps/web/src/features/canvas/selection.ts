import type { Id } from '@schemaloom/schema-model';

/**
 * The selection reducer, as pure functions over an immutable set.
 *
 * Separate from the zustand store on purpose: this is the part with the edge cases
 * (shift-click a selected node, extend an empty selection, replace with nothing), and a
 * reducer that needs a React store mounted to be tested is a reducer nobody tests.
 */
export type Selection = ReadonlySet<Id>;

export const EMPTY_SELECTION: Selection = new Set<Id>();

export type SelectMode = 'replace' | 'toggle' | 'extend';

export function selectOnly(ids: readonly Id[]): Selection {
  return new Set(ids);
}

/** Shift-click: a selected node leaves the selection, an unselected one joins it. */
export function toggleSelection(current: Selection, id: Id): Selection {
  const next = new Set(current);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function extendSelection(current: Selection, ids: readonly Id[]): Selection {
  const next = new Set(current);
  for (const id of ids) next.add(id);
  return next;
}

export function applySelect(current: Selection, ids: readonly Id[], mode: SelectMode): Selection {
  if (mode === 'replace') return selectOnly(ids);
  if (mode === 'extend') return extendSelection(current, ids);
  return ids.reduce<Selection>(toggleSelection, current);
}

/** Set equality, so the store can skip a notify that would re-render every node. */
export function sameSelection(a: Selection, b: Selection): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
