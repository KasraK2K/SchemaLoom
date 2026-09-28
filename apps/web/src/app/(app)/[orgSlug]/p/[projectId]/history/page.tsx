import Link from 'next/link';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { HistoryView } from '@/features/history/history-view';
import { ProjectTabs } from '@/features/history/project-tabs';

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
      breadcrumb={
        <span className="flex min-w-0 items-center gap-3">
          <Link href={`/${orgSlug}`} className="truncate hover:text-text">
            {orgSlug} / project
          </Link>
          <ProjectTabs orgSlug={orgSlug} projectId={projectId} />
        </span>
      }
    >
      <HistoryView orgSlug={orgSlug} projectId={projectId} />
    </AppShell>
  );
}
