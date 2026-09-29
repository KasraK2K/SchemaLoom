import type { Id, Point } from '@schemaloom/schema-model';
import { create } from 'zustand';
import { canRedo, canUndo, emptyHistory, record, redo, undo, type History } from './history';
import {
  EMPTY_SELECTION,
  applySelect,
  sameSelection,
  type SelectMode,
  type Selection,
} from './selection';

/**
 * Canvas interaction state — doc 01 §5.2's client half. The RSC fetches; this owns what
 * the user is doing.
 *
 * IT DOES NOT OWN NODE POSITIONS. React Flow does, because React Flow is what moves them
 * sixty times a second; a second copy here would be two sources of truth for the one piece
 * of state that changes most. The store keeps the UNDO RECORD of a finished gesture —
 * where each node was before and after a drag — and hands the entries back for the surface
 * to apply and persist. That also keeps the store free of the network.
 *
 * Module-level rather than a provider: one project is open at a time, and the inspector
 * lives in `AppShell`'s `rightPanel` — a sibling subtree of the canvas, not a descendant.
 * A context would have to wrap `AppShell` itself to reach both. `reset()` on project
 * change is the one line that buys back what a provider would have given for free.
 */
export interface MoveEntry {
  readonly id: Id;
  readonly before: Point;
  readonly after: Point;
}

/** One gesture — a drag of three selected cards is ONE undo step, not three. */
export type MoveBatch = readonly MoveEntry[];

export interface CanvasState {
  readonly selection: Selection;
  /** The field inside `selection`'s entity that the inspector is showing, if any. */
  readonly selectedFieldId: Id | null;
  readonly collapsed: ReadonlySet<Id>;
  readonly history: History<MoveBatch>;

  // Property syntax, not method syntax: these are read off the store as standalone
  // functions (`const { reset } = useCanvasStore.getState()`), and a method signature
  // declares an unbound `this` that lint rightly refuses to let travel.
  readonly select: (ids: readonly Id[], mode?: SelectMode) => void;
  readonly selectField: (entityId: Id, fieldId: Id) => void;
  readonly clearSelection: () => void;
  readonly toggleCollapse: (entityId: Id) => void;
  readonly recordMove: (batch: MoveBatch) => void;
  /** The positions to restore, or `null` when there was nothing to undo. */
  readonly undoMove: () => readonly { id: Id; position: Point }[] | null;
  readonly redoMove: () => readonly { id: Id; position: Point }[] | null;
  readonly reset: () => void;
}

const INITIAL = {
  selection: EMPTY_SELECTION,
  selectedFieldId: null,
  collapsed: new Set<Id>() as ReadonlySet<Id>,
  history: emptyHistory<MoveBatch>(),
};

export const useCanvasStore = create<CanvasState>()((set, get) => ({
  ...INITIAL,

  select(ids, mode = 'replace') {
    const current = get().selection;
    const next = applySelect(current, ids, mode);
    // A no-op set would still notify every subscribed node. `onSelectionChange` fires on
    // every pointer move during a lasso, so this guard is not a micro-optimisation.
    if (sameSelection(current, next)) return;
    set({ selection: next, selectedFieldId: null });
  },

  selectField(entityId, fieldId) {
    set({ selection: new Set([entityId]), selectedFieldId: fieldId });
  },

  clearSelection() {
    if (get().selection.size === 0 && get().selectedFieldId === null) return;
    set({ selection: EMPTY_SELECTION, selectedFieldId: null });
  },

  toggleCollapse(entityId) {
    const next = new Set(get().collapsed);
    if (!next.delete(entityId)) next.add(entityId);
    set({ collapsed: next });
  },

  recordMove(batch) {
    if (batch.length === 0) return;
    set({ history: record(get().history, batch) });
  },

  undoMove() {
    const step = undo(get().history);
    if (step.entry === undefined) return null;
    set({ history: step.history });
    return step.entry.map((move) => ({ id: move.id, position: move.before }));
  },

  redoMove() {
    const step = redo(get().history);
    if (step.entry === undefined) return null;
    set({ history: step.history });
    return step.entry.map((move) => ({ id: move.id, position: move.after }));
  },

  reset() {
    set({ ...INITIAL, collapsed: new Set<Id>(), history: emptyHistory<MoveBatch>() });
  },
}));

export const selectCanUndo = (state: CanvasState): boolean => canUndo(state.history);
export const selectCanRedo = (state: CanvasState): boolean => canRedo(state.history);
