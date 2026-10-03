'use client';

import {
  BaseEdge,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  type EdgeProps,
} from '@xyflow/react';
import { useTheme } from '@/components/theme-provider';
import { markerUrl } from './crow-foot';
import type { LinkEdge as LinkEdgeType } from './graph';
import { useCanvasStore } from './store';

/**
 * One edge renderer for every link kind. It branches on the `LinkStyle` the engine
 * supplied, never on `link.kind` — adding a kind to an engine's capabilities must not need
 * an edit here.
 *
 * A restricted link is drawn as a faded stub: the server already blanked its name and, when
 * either end was hidden, cleared its endpoints, so there is nothing to label. Drawing it
 * anyway is the point — an unexplained line to a stub box is what tells a viewer that
 * something they cannot see is connected to something they can.
 */
export function LinkEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<LinkEdgeType>) {
  // The line is the theme's: right angles (Blueprint), straight (Compact), curves
  // (Studio, and thicker in Float).
  const { theme } = useTheme().look;
  const ends = { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition };
  const [path] =
    theme === 'blueprint'
      ? getSmoothStepPath({ ...ends, borderRadius: 0 })
      : theme === 'compact'
        ? getStraightPath(ends)
        : getBezierPath(ends);
  const width = theme === 'float' ? 2 : theme === 'compact' ? 1 : 1.5;

  // A link of the selected table lights up with it, so its connections can be followed.
  // A boolean slice: selecting another card re-renders only the edges whose answer changed.
  const touchesSelection = useCanvasStore(
    (state) => state.selection.has(source) || state.selection.has(target),
  );
  const lit = selected === true || touchesSelection;
  const style = data?.style ?? null;
  const restricted = data?.link.restricted === true;

  return (
    <BaseEdge
      id={id}
      path={path}
      markerStart={markerUrl(style?.sourceMarker)}
      markerEnd={markerUrl(style?.targetMarker)}
      style={{
        stroke: lit ? 'var(--color-accent)' : 'var(--color-border-strong)',
        strokeWidth: lit ? width + 0.5 : width,
        // A documentation-only link is not a database constraint, and the canvas says so.
        strokeDasharray: style?.dashed === true ? '6 4' : undefined,
        opacity: restricted ? 0.4 : 1,
      }}
    />
  );
}
