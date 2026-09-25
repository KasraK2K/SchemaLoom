'use client';

import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import { markerUrl } from './crow-foot';
import type { LinkEdge as LinkEdgeType } from './graph';

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
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps<LinkEdgeType>) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const style = data?.style ?? null;
  const restricted = data?.link.restricted === true;

  return (
    <BaseEdge
      id={id}
      path={path}
      markerStart={markerUrl(style?.sourceMarker)}
      markerEnd={markerUrl(style?.targetMarker)}
      style={{
        stroke: selected === true ? 'var(--color-accent)' : 'var(--color-border-strong)',
        strokeWidth: selected === true ? 2 : 1.5,
        // A documentation-only link is not a database constraint, and the canvas says so.
        strokeDasharray: style?.dashed === true ? '6 4' : undefined,
        opacity: restricted ? 0.4 : 1,
      }}
    />
  );
}
