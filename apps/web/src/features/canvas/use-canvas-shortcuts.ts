'use client';

import { useEffect, useRef } from 'react';

/**
 * Canvas keyboard shortcuts (§6.1).
 *
 * On `window` rather than on the canvas element: React Flow's pane only has focus after a
 * click, and an undo that silently does nothing because the user last touched the
 * inspector is worse than no shortcut.
 *
 * Typing is never a shortcut. The guard is on the event TARGET, not on a "is a dialog
 * open" flag, because the inspector, the docs editor and the command palette all put a
 * caret on the page and none of them should have to remember to suspend the canvas.
 */
export interface CanvasShortcuts {
  readonly undo: () => void;
  readonly redo: () => void;
  readonly clearSelection: () => void;
  readonly autoLayout: () => void;
  readonly fitView: () => void;
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function useCanvasShortcuts(handlers: CanvasShortcuts): void {
  // The latest-ref pattern, and not a convenience: `handlers` is rebuilt every render, so
  // listing it as a dependency would tear down and re-add a window listener on every
  // frame of a drag.
  const latest = useRef(handlers);
  useEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isTyping(event.target)) return;
      const current = latest.current;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();

      if (mod && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) current.redo();
        else current.undo();
        return;
      }
      // Ctrl+Y is the Windows spelling of redo and costs one branch.
      if (mod && key === 'y') {
        event.preventDefault();
        current.redo();
        return;
      }
      if (mod && event.shiftKey && key === 'l') {
        event.preventDefault();
        current.autoLayout();
        return;
      }
      if (!mod && key === 'f') {
        current.fitView();
        return;
      }
      if (key === 'escape') current.clearSelection();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);
}
