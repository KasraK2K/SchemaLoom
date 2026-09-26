import { HydrationBoundary } from '@tanstack/react-query';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { CanvasClient } from '@/features/canvas/canvas-client';
import { dehydrateIr } from '@/features/canvas/ir-prefetch';
import { InspectorPanel } from '@/features/inspector/inspector-panel';
import { ProjectShareButton } from '@/features/sharing';

/**
 * The canvas route — doc 01 §5.2.
 *
 * A Server Component that prefetches the IR query and dehydrates ONLY that query into a
 * `HydrationBoundary` scoped to this route. The IR is deliberately not fetched in the
 * project LAYOUT: a 300-entity model serialised there is inlined in the HTML, re-sent on
 * every layout render, and paid in full by a user who navigated to `/settings`.
 *
 * Mutations go from the client straight to the API (TanStack Query), never through a Next
 * Server Action: the API already owns auth, validation and permissions, and a server action
 * would add a second hop and a second place to re-implement the guard.
 */
export default async function ProjectCanvasPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = await params;
  const state = await dehydrateIr(projectId);

  return (
    <HydrationBoundary state={state}>
      <AppShell
        nav={orgNavItems(orgSlug)}
        orgLabel={orgSlug}
        breadcrumb={
          // A link, not text: this is the way back out of a project, and for a while it
          // was the only screen in the app you could not navigate away from.
          <Link href={`/${orgSlug}`} className="truncate hover:text-text">
            {orgSlug} / project
          </Link>
        }
        actions={<ProjectShareButton projectId={projectId} />}
        rightPanel={<InspectorPanel projectId={projectId} />}
      >
        <CanvasClient projectId={projectId} />
      </AppShell>
    </HydrationBoundary>
  );
}
