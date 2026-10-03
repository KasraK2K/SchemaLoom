import { HydrationBoundary } from '@tanstack/react-query';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { CanvasClient } from '@/features/canvas/canvas-client';
import { dehydrateIr } from '@/features/canvas/ir-prefetch';
import { ChangeRequestActions } from '@/features/change-requests/change-requests-view';
import { ExportMenu } from '@/features/exports/export-menu';
import { ProjectBreadcrumb } from '@/features/history/project-tabs';
import { InspectorPanel } from '@/features/inspector/inspector-panel';
import { ProjectSettingsDialog } from '@/features/project/project-settings-dialog';
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
        breadcrumb={<ProjectBreadcrumb orgSlug={orgSlug} projectId={projectId} />}
        actions={
          <>
            <ChangeRequestActions orgSlug={orgSlug} projectId={projectId} />
            <ExportMenu projectId={projectId} />
            <ProjectSettingsDialog projectId={projectId} />
            <ProjectShareButton projectId={projectId} />
          </>
        }
        rightPanel={<InspectorPanel projectId={projectId} />}
        fullBleed
      >
        <CanvasClient projectId={projectId} />
      </AppShell>
    </HydrationBoundary>
  );
}
