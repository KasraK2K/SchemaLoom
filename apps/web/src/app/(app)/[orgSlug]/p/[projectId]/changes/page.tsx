import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { ChangesView } from '@/features/change-requests/change-requests-view';
import { ProjectBreadcrumb } from '@/features/history/project-tabs';

/** Phase 10 §1 — the project's change requests. */
export default async function ProjectChangesPage({
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
      <ChangesView orgSlug={orgSlug} projectId={projectId} />
    </AppShell>
  );
}
