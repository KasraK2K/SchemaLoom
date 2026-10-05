'use client';

import {
  Button,
  FilePlus2,
  Group,
  LayoutGrid,
  Maximize,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Upload,
} from '@schemaloom/ui';
import { useReactFlow, useViewport } from '@xyflow/react';
import { fitPadding } from './fit-padding';

/** One editing action. Absent = not offered here (read-only canvas, no import format…). */
export interface ToolbarAction {
  readonly label: string;
  readonly onSelect: () => void;
  readonly title?: string;
}

const ICONS = {
  add: FilePlus2,
  group: Group,
  import: Upload,
  describe: Sparkles,
  sync: RefreshCw,
  layout: LayoutGrid,
} as const;

/**
 * The canvas's one floating toolbar, bottom centre: the editing actions, then zoom. Zoom is
 * always there, read-only or not; the actions appear only when the caller passes them.
 * Rendered inside `<ReactFlow>` (a `Panel`), which is what the viewport hooks need.
 */
export function CanvasToolbar({
  actions,
}: {
  readonly actions: Partial<Record<keyof typeof ICONS, ToolbarAction>>;
}) {
  const flow = useReactFlow();
  const { zoom } = useViewport();
  const entries = (Object.keys(ICONS) as (keyof typeof ICONS)[]).flatMap((key) => {
    const action = actions[key];
    return action === undefined ? [] : [{ key, action, Icon: ICONS[key] }];
  });

  return (
    <div
      role="toolbar"
      aria-label="Canvas"
      className="flex items-center gap-0.5 rounded-lg border border-border bg-surface-raised p-1 shadow-panel"
    >
      {entries.map(({ key, action, Icon }) => (
        <Button
          key={key}
          variant="ghost"
          size="sm"
          title={action.title}
          onClick={action.onSelect}
          className="gap-1.5 text-text-muted hover:text-text"
        >
          <Icon className="size-3.5" aria-hidden="true" />
          {action.label}
        </Button>
      ))}
      {entries.length > 0 && <span aria-hidden="true" className="mx-1 h-5 w-px bg-border" />}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Zoom out"
        onClick={() => void flow.zoomOut({ duration: 150 })}
        className="size-7 text-text-muted"
      >
        <Minus className="size-3.5" aria-hidden="true" />
      </Button>
      <span className="w-11 text-center font-mono text-xs text-text-muted tabular-nums">
        {Math.round(zoom * 100)}%
      </span>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Zoom in"
        onClick={() => void flow.zoomIn({ duration: 150 })}
        className="size-7 text-text-muted"
      >
        <Plus className="size-3.5" aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Fit to view"
        onClick={() => void flow.fitView({ padding: fitPadding(), duration: 200 })}
        className="size-7 text-text-muted"
      >
        <Maximize className="size-3.5" aria-hidden="true" />
      </Button>
    </div>
  );
}
