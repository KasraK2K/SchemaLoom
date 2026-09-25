'use client';

// The side-effect registration of every engine (§16.0). Imported here because this is the
// one component that resolves an engine for an open project; `register.ts` stays the only
// module in the app that may name an engine id.
import '@/engines/register';

import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense, type ReactNode } from 'react';
import { EngineProvider } from '@/engines';
import { irQueryOptions } from '@/features/canvas/ir-query';

/**
 * Resolves the open project's engine and puts it in context.
 *
 * Mounted once per PANE rather than once above the whole shell, and that is deliberate:
 * the inspector lives in `AppShell`'s `rightPanel` prop, a sibling subtree of the canvas,
 * so a single provider would have to wrap `AppShell` itself — and then the top bar and the
 * sidebar would blank out behind the engine chunk's `<Suspense>` on every project open.
 * Two gates cost nothing: both registries memoise the PROMISE, so the facet is fetched
 * once, resolves to one object, and both panes share it.
 *
 * The IR query is read here only for `engineId`. It is the same query key the canvas and
 * the inspector use, already hydrated by the route's RSC prefetch, so this is a cache read
 * and not a second request.
 */
export function EngineGate({
  projectId,
  fallback,
  children,
}: {
  readonly projectId: string;
  readonly fallback: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <ResolvedEngine projectId={projectId}>{children}</ResolvedEngine>
    </Suspense>
  );
}

function ResolvedEngine({
  projectId,
  children,
}: {
  readonly projectId: string;
  readonly children: ReactNode;
}) {
  const { data } = useSuspenseQuery(irQueryOptions(projectId));
  return <EngineProvider engineId={data.engineId}>{children}</EngineProvider>;
}
