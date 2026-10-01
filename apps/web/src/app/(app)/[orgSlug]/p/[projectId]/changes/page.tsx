import Link from 'next/link';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { ChangesView } from '@/features/change-requests/change-requests-view';
import { ProjectTabs } from '@/features/history/project-tabs';

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
      breadcrumb={
        <span className="flex min-w-0 items-center gap-3">
          <Link href={`/${orgSlug}`} className="truncate hover:text-text">
            {orgSlug} / project
          </Link>
          <ProjectTabs orgSlug={orgSlug} projectId={projectId} />
        </span>
      }
    >
      <ChangesView orgSlug={orgSlug} projectId={projectId} />
    </AppShell>
  );
}
