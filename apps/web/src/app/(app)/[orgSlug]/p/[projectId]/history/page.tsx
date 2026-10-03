import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { HistoryView } from '@/features/history/history-view';
import { ProjectBreadcrumb } from '@/features/history/project-tabs';

/** Phase 4 §1.2 — the project's second view: snapshots and diffs. */
export default async function ProjectHistoryPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string }>;
}) {
  const { orgSlug, projectId } = await params;
  return (
    <AppShell
      nav={orgNavItems(orgSlug)}
      orgLabel={orgSlug}
      breadcrumb={<ProjectBreadcrumb orgSlug={orgSlug} projectId={projectId} />}
    >
      <HistoryView orgSlug={orgSlug} projectId={projectId} />
    </AppShell>
  );
}
