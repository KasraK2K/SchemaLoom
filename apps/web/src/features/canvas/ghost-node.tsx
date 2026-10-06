'use client';

import { cn } from '@schemaloom/ui';
import { BaseEdge, getBezierPath, type EdgeProps, type NodeProps } from '@xyflow/react';
import { createContext, useContext } from 'react';
import type { GhostHover } from '@/features/ai/describe-schema';
import { NodeHandles } from './field-handle';
import {
  GHOST_HEADER,
  GHOST_ROW,
  type GhostAreaNode as GhostAreaNodeType,
  type GhostLinkEdge as GhostLinkEdgeType,
  type GhostNode as GhostNodeType,
} from './ghost';

/** The ghost the pointer is on, shared by the canvas and the Describe panel's summary. */
export const GhostHoverContext = createContext<GhostHover>({
  hovered: null,
  onHover: () => undefined,
});

/**
 * A table the draft would create (Phase 22b D1): the theme's card at `--ghost-opacity`, with
 * a dashed `--ghost-border` outline. Fixed row heights (`ghostHeight`), so placement is
 * known before anything is drawn. Not draggable, editable or connectable: Refine changes it.
 */
export function GhostNode({ data }: NodeProps<GhostNodeType>) {
  const { hovered, onHover } = useContext(GhostHoverContext);
  const { table } = data;
  const lit = hovered === table.key;
  return (
    <div
      data-testid="ghost-table"
      data-ghost-key={table.key}
      onPointerEnter={() => {
        onHover(table.key);
      }}
      onPointerLeave={() => {
        onHover(null);
      }}
      className={cn(
        'pointer-events-auto size-full overflow-hidden rounded-lg border-[1.5px] border-dashed bg-surface-raised opacity-(--ghost-opacity) theme-blueprint:bg-canvas',
        lit ? 'border-accent opacity-90' : 'border-(--ghost-border)',
      )}
    >
      <NodeHandles />
      <header
        style={{ height: GHOST_HEADER }}
        className="flex items-center gap-2 border-b border-dashed border-(--ghost-border) bg-surface-sunken px-2.5 theme-blueprint:bg-transparent theme-compact:bg-transparent"
      >
        <span className="text-xs text-text-subtle" aria-hidden="true">
          +
        </span>
        <span className="truncate text-[13px] font-semibold text-text theme-blueprint:font-mono theme-blueprint:text-[11px] theme-blueprint:tracking-[0.07em] theme-blueprint:uppercase theme-compact:text-xs theme-compact:tracking-wider theme-compact:uppercase">
          {table.name}
        </span>
      </header>
      <ul className="py-1">
        {table.columns.map((column) => (
          <li
            key={column.name}
            style={{ height: GHOST_ROW }}
            className="flex items-center gap-2 px-2.5 text-xs"
          >
            <span className="truncate text-text">{column.name}</span>
            {column.pk ? <span className="text-accent-text">PK</span> : null}
            <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">
              {column.type}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The card the draft's tables would be grouped into (Q2): an area card, dashed. */
export function GhostAreaNode({ data }: NodeProps<GhostAreaNodeType>) {
  return (
    <div
      data-testid="ghost-area"
      className="relative size-full rounded-lg border-[1.5px] border-dashed border-(--ghost-border) bg-(--ghost-area)"
    >
      <span className="absolute top-1.5 left-2 truncate px-1.5 py-0.5 text-xs leading-4 font-medium text-text-muted select-none theme-blueprint:font-mono theme-blueprint:tracking-wide theme-blueprint:uppercase">
        {data.name}
      </span>
    </div>
  );
}

/** A relation the draft would add: always dashed, in the ghost colour. */
export function GhostLinkEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps<GhostLinkEdgeType>) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  return (
    <BaseEdge
      id={id}
      path={path}
      className="ghost-link"
      style={{ stroke: 'var(--ghost-border)', strokeWidth: 1.5, strokeDasharray: '6 4' }}
    />
  );
}

/** Columns the draft adds to an existing table (22b §1): faded `+` rows under its card. */
export function PendingColumns({
  entityId,
  columns,
}: {
  readonly entityId: string;
  readonly columns: readonly { readonly name: string; readonly type: string }[];
}) {
  const { hovered, onHover } = useContext(GhostHoverContext);
  return (
    <ul
      data-testid="pending-columns"
      onPointerEnter={() => {
        onHover(entityId);
      }}
      onPointerLeave={() => {
        onHover(null);
      }}
      className={cn(
        '-mt-px rounded-b-lg border-[1.5px] border-t-0 border-dashed bg-surface-raised py-1 opacity-(--ghost-opacity)',
        hovered === entityId ? 'border-accent opacity-90' : 'border-(--ghost-border)',
      )}
    >
      {columns.map((column) => (
        <li key={column.name} className="flex items-center gap-2 px-2.5 py-0.5 text-xs">
          <span className="text-text-subtle" aria-hidden="true">
            +
          </span>
          <span className="truncate text-text">{column.name}</span>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-text-muted">
            {column.type}
          </span>
        </li>
      ))}
    </ul>
  );
}
