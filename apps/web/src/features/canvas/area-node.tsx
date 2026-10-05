'use client';

import type { Id } from '@schemaloom/schema-model';
import { ChevronDown } from '@schemaloom/ui';
import type { NodeProps } from '@xyflow/react';
import { createContext, useContext, type PointerEvent } from 'react';
import type { AreaNode as AreaNodeType, AreaNodeData } from './graph';

/**
 * What the canvas hands every card. In a context and not in `node.data` because cards are
 * rebuilt from the table nodes on every render (`buildAreaNodes`), and callbacks in `data`
 * would make each rebuild look like a change.
 */
export interface AreaCanvas {
  /** a share-link visitor or a protected project: the label is text, nothing writes */
  readonly readOnly: boolean;
  /** the card whose name is being typed, if any (a new card starts in this state) */
  readonly editingId: Id | null;
  /** `opensMenu`: a click without a drag opens the label menu (the label, not the body) */
  readonly onLabelDown: (data: AreaNodeData, event: PointerEvent, opensMenu?: boolean) => void;
  readonly onLabelMenu: (data: AreaNodeData, x: number, y: number) => void;
  /** double-click on the label */
  readonly onStartRename: (data: AreaNodeData) => void;
  readonly onRename: (data: AreaNodeData, name: string | null) => void;
}

const NO_CANVAS: AreaCanvas = {
  readOnly: true,
  editingId: null,
  onLabelDown: () => undefined,
  onLabelMenu: () => undefined,
  onStartRename: () => undefined,
  onRename: () => undefined,
};

export const AreaCanvasContext = createContext<AreaCanvas>(NO_CANVAS);

/**
 * A card behind its tables (docs/phase23/AREA-CARDS.md D5): a quiet tint, a thin border in
 * the area colour, the theme's corner radius and a small name label. Colours come from the
 * theme's `--color-area-N` / `--color-area-N-border` tokens, so each appearance theme paints
 * its own. The node wrapper takes no pointer (React Flow sees it as neither selectable nor
 * draggable); only the label opts back in.
 */
export function AreaNode({ data }: NodeProps<AreaNodeType>) {
  const canvas = useContext(AreaCanvasContext);
  const { area } = data;
  const editing = !canvas.readOnly && canvas.editingId === area.id;

  return (
    <div
      data-testid="area-card"
      data-area-id={area.id}
      data-highlighted={data.highlighted}
      // The empty part of the card drags it with all its tables. `nopan` keeps the canvas
      // from panning instead; tables sit above the card and take their own drags.
      onPointerDown={(e) => {
        if (!canvas.readOnly && e.target === e.currentTarget) canvas.onLabelDown(data, e, false);
      }}
      className={`relative size-full rounded-lg border transition-shadow ${
        canvas.readOnly
          ? ''
          : 'nopan pointer-events-auto cursor-grab touch-none active:cursor-grabbing'
      }`}
      style={{
        backgroundColor: data.fill,
        borderColor: data.border,
        boxShadow: data.highlighted ? `0 0 0 3px ${data.border}` : undefined,
      }}
    >
      {editing ? (
        <input
          aria-label="Area name"
          autoFocus
          maxLength={200}
          defaultValue={area.name}
          onFocus={(e) => {
            e.currentTarget.select();
          }}
          onBlur={(e) => {
            canvas.onRename(data, e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            // Escape must not also clear the canvas selection behind the input.
            if (e.key === 'Escape') {
              e.stopPropagation();
              canvas.onRename(data, null);
            }
          }}
          className="pointer-events-auto absolute top-1.5 left-2 h-6 w-48 max-w-[calc(100%-1rem)] rounded-sm border border-border-strong bg-surface px-1.5 text-xs font-medium text-text theme-blueprint:font-mono"
        />
      ) : canvas.readOnly ? (
        <Label>{area.name}</Label>
      ) : (
        <button
          type="button"
          title="Click for options (rename, colour, ungroup). Double-click to rename. Drag to move."
          onPointerDown={(e) => {
            canvas.onLabelDown(data, e);
          }}
          onDoubleClick={() => {
            canvas.onStartRename(data);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            canvas.onLabelMenu(data, e.clientX, e.clientY);
          }}
          className="pointer-events-auto absolute top-1.5 left-2 max-w-[calc(100%-1rem)] cursor-grab touch-none rounded-sm px-1.5 py-0.5 text-left hover:bg-surface-hover/60 active:cursor-grabbing"
        >
          <span className="flex items-center gap-1">
            <Label>{area.name}</Label>
            <ChevronDown className="size-3 shrink-0 text-text-subtle" aria-hidden="true" />
          </span>
        </button>
      )}
    </div>
  );
}

function Label({ children }: { readonly children: string }) {
  return (
    <span className="block truncate text-xs leading-4 font-medium text-text-muted select-none theme-blueprint:font-mono theme-blueprint:tracking-wide theme-blueprint:uppercase">
      {children}
    </span>
  );
}
