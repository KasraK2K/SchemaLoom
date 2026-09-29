import { HydrationBoundary } from '@tanstack/react-query';
import Link from 'next/link';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { dehydrateIr } from '@/features/canvas/ir-prefetch';
import { DocsView } from '@/features/docs/docs-view';
import { ExportMenu } from '@/features/exports/export-menu';
import { ProjectTabs } from '@/features/history/project-tabs';
import { EngineGate } from '@/features/project/engine-gate';

/**
 * Phase 5 §1 — docs mode: the project's documentation as one readable page. The IR is
 * prefetched like the canvas route's, because `EngineGate` suspends on it for the
 * terminology.
 */
export default async function ProjectDocsPage({
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
          <span className="flex min-w-0 items-center gap-3">
            <Link href={`/${orgSlug}`} className="truncate hover:text-text">
              {orgSlug} / project
            </Link>
            <ProjectTabs orgSlug={orgSlug} projectId={projectId} />
          </span>
        }
      >
        <EngineGate projectId={projectId} fallback={<p className="p-4 text-sm text-text-subtle">Loading…</p>}>
          <DocsView projectId={projectId} actions={<ExportMenu projectId={projectId} images={false} />} />
        </EngineGate>
      </AppShell>
    </HydrationBoundary>
  );
}
