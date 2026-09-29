'use client';

import { cn } from '@schemaloom/ui';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * Width + collapsed state for a side panel, remembered per browser. A per-person layout
 * preference, so localStorage (like the canvas grid settings), never the server.
 */
export interface PanelBounds {
  readonly defaultWidth: number;
  readonly min: number;
  readonly max: number;
}

export function clampWidth(width: number, { min, max }: PanelBounds): number {
  return Math.round(Math.min(max, Math.max(min, width)));
}

/**
 * The width after dragging from `startX` to `x`. A left panel grows as the pointer moves
 * right; a right panel grows as it moves left, because its handle is on its left edge.
 */
export function dragWidth(
  side: 'left' | 'right',
  startWidth: number,
  startX: number,
  x: number,
  bounds: PanelBounds,
): number {
  const delta = side === 'left' ? x - startX : startX - x;
  return clampWidth(startWidth + delta, bounds);
}

export function usePanelState(storageKey: string, bounds: PanelBounds) {
  const [width, setWidth] = useState(bounds.defaultWidth);
  const [collapsed, setCollapsed] = useState(false);
  // Until the stored value has been read, the save effect must not overwrite it with the
  // defaults of the first render.
  const loaded = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw !== null) {
        const stored = JSON.parse(raw) as { width?: unknown; collapsed?: unknown };
        if (typeof stored.width === 'number') setWidth(clampWidth(stored.width, bounds));
        if (typeof stored.collapsed === 'boolean') setCollapsed(stored.collapsed);
      }
    } catch {
      // Blocked or corrupt storage: keep the defaults.
    }
    loaded.current = true;
    // `bounds` is a constant per call site, so only the key re-reads storage.
  }, [storageKey]);

  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify({ width, collapsed }));
    } catch {
      // Not persisted; the layout still works for this page view.
    }
  }, [storageKey, width, collapsed]);

  return { width, setWidth, collapsed, setCollapsed };
}

/**
 * The drag edge between a side panel and the canvas. Pointer drag, plus arrow keys for
 * keyboard users (`role="separator"` is the ARIA window-splitter pattern).
 */
export function ResizeHandle({
  side,
  width,
  bounds,
  onResize,
  label,
}: {
  readonly side: 'left' | 'right';
  readonly width: number;
  readonly bounds: PanelBounds;
  readonly onResize: (width: number) => void;
  readonly label: string;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current === null) return;
    onResize(dragWidth(side, start.current.width, start.current.x, event.clientX, bounds));
  };
  const onPointerUp = () => {
    start.current = null;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' ? 16 : event.key === 'ArrowLeft' ? -16 : 0;
    if (step === 0) return;
    event.preventDefault();
    onResize(clampWidth(width + (side === 'left' ? step : -step), bounds));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      className={cn(
        'absolute inset-y-0 z-10 w-1.5 cursor-col-resize touch-none transition-colors hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none',
        side === 'left' ? '-right-0.5' : '-left-0.5',
      )}
    />
  );
}
