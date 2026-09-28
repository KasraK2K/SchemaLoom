'use client';

import type { Id } from '@schemaloom/schema-model';
import { useSuspenseQuery } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { CanvasSurface } from './canvas-surface';
import { irQueryOptions } from './ir-query';
import { useRealtime } from './realtime';

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
  // Share-link visitors (`readOnly`) get patches, never presence (doc 05 L16 + R21).
  const { unavailable } = useRealtime(projectId, { presence: !readOnly });
  if (unavailable) return <NotAvailable />;
  return <LiveCanvas projectId={projectId} readOnly={readOnly} />;
}

/** Doc 05 §12.2 — the socket was closed with 4403: access is gone, and so is the model. */
function NotAvailable() {
  return (
    <div className="flex h-full items-center justify-center bg-canvas" role="status">
      <span className="text-sm text-text-subtle">This project is no longer available to you.</span>
    </div>
  );
}

function LiveCanvas({ projectId, readOnly }: { readonly projectId: Id; readonly readOnly: boolean }) {
  const { data } = useSuspenseQuery(irQueryOptions(projectId));
  return (
    <ReactFlowProvider>
      <CanvasSurface projectId={projectId} model={data} readOnly={readOnly} />
    </ReactFlowProvider>
  );
}

export default CanvasRoot;
