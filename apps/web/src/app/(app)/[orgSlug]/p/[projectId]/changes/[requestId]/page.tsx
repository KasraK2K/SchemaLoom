import Link from 'next/link';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { ChangeRequestView } from '@/features/change-requests/change-requests-view';
import { ProjectTabs } from '@/features/history/project-tabs';

/** Phase 10 §1 — one change request: diff, migration SQL, reviews, merge. */
export default async function ChangeRequestPage({
  params,
}: {
  params: Promise<{ orgSlug: string; projectId: string; requestId: string }>;
}) {
  const { orgSlug, projectId, requestId } = await params;
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
      <ChangeRequestView orgSlug={orgSlug} projectId={projectId} requestId={requestId} />
    </AppShell>
  );
}
