'use client';

import type { Id } from '@schemaloom/schema-model';
import dynamic from 'next/dynamic';
import { useEffect } from 'react';
import { EngineGate } from '@/features/project/engine-gate';
import { useCanvasStore } from './store';

/**
 * The canvas island. Doc 01 §5.2: `<CanvasView>` is a client component loaded with
 * `dynamic(..., { ssr: false })`, because React Flow measures the DOM — its SSR output is
 * thrown away on hydration and costs a full render of 300+ nodes to produce.
 *
 * `next/dynamic` with `ssr: false` is only legal inside a client component, which is why
 * this thin file exists at all: the route itself is a Server Component.
 */
const CanvasRoot = dynamic(() => import('./canvas-root'), {
  ssr: false,
  loading: () => <CanvasSkeleton />,
});

export function CanvasClient({
  projectId,
  readOnly = false,
}: {
  readonly projectId: Id;
  /** Share-link visitors — see `CanvasSurface`. */
  readonly readOnly?: boolean;
}) {
  // Selection, collapse and the undo stack are about THIS project. The store is module
  // level (see its header), so switching projects without this leaves the previous
  // project's undo entries pointing at ids that no longer exist.
  useEffect(() => {
    const { reset, select } = useCanvasStore.getState();
    reset();
    // History's "Show on canvas" links here with `?select=<entityId>`. Read once, on the
    // project switch, straight off `location`: `useSearchParams` would need a Suspense
    // boundary around the whole canvas for a one-shot read.
    const ids = new URLSearchParams(window.location.search).get('select');
    if (ids !== null && ids !== '') select(ids.split(','));
    return reset;
  }, [projectId]);

  return (
    <EngineGate projectId={projectId} fallback={<CanvasSkeleton />}>
      <CanvasRoot projectId={projectId} readOnly={readOnly} />
    </EngineGate>
  );
}

function CanvasSkeleton() {
  return (
    <div className="flex h-full items-center justify-center bg-canvas">
      <span className="text-sm text-text-subtle">Loading the diagram…</span>
    </div>
  );
}
