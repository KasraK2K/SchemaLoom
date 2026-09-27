'use client';

import type { Id } from '@schemaloom/schema-model';
import { useSuspenseQuery } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { CanvasSurface } from './canvas-surface';
import { irQueryOptions } from './ir-query';

/**
 * The lazily-loaded half. `ReactFlowProvider` lives HERE and not in `canvas-client.tsx`
 * because importing it there would pull React Flow into the main bundle and undo the
 * `ssr: false` dynamic import that exists to keep it out.
 */
export function CanvasRoot({
  projectId,
  readOnly = false,
}: {
  readonly projectId: Id;
  readonly readOnly?: boolean;
}) {
  const { data } = useSuspenseQuery(irQueryOptions(projectId));
  return (
    <ReactFlowProvider>
      <CanvasSurface projectId={projectId} model={data} readOnly={readOnly} />
    </ReactFlowProvider>
  );
}

export default CanvasRoot;
