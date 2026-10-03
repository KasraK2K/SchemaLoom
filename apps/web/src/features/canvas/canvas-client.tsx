'use client';

import { Loading, Skeleton } from '@schemaloom/ui';

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
    <Loading label="Loading the diagram…" className="relative h-full overflow-hidden bg-canvas">
      {[
        'left-[12%] top-[18%] h-36',
        'left-[42%] top-[30%] h-44',
        'left-[70%] top-[16%] h-32',
        'left-[20%] top-[58%] h-28',
      ].map((place) => (
        <div
          key={place}
          className={`absolute w-52 overflow-hidden rounded-lg border border-border bg-surface-raised ${place}`}
        >
          <Skeleton className="h-9 rounded-none" />
          <div className="flex flex-col gap-2.5 p-3">
            <Skeleton className="h-2.5 w-3/4" />
            <Skeleton className="h-2.5 w-1/2" />
            <Skeleton className="h-2.5 w-2/3" />
          </div>
        </div>
      ))}
    </Loading>
  );
}
