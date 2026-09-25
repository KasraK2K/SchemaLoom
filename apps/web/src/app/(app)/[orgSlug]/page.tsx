import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';

/** Workspace overview. Next 15: `params` is a Promise. */
export default async function OrgOverviewPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;

  return (
    <AppShell nav={orgNavItems(orgSlug)} breadcrumb={<span className="truncate">{orgSlug}</span>}>
      <div className="mx-auto max-w-3xl p-8">
        <h1 className="text-lg font-semibold text-text">{orgSlug}</h1>
        <p className="mt-1 text-sm text-text-muted">
          Workspaces and projects appear here once the API read path is wired up.
        </p>
      </div>
    </AppShell>
  );
}
