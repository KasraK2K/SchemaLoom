import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import {
  NoProjects,
  ProjectList,
  listEngines,
  listOrganizations,
  listProjects,
} from '@/features/projects';

/**
 * The org's project list — every row links into the canvas.
 *
 * The two reads go out together: `listProjects` answers `[]` for a slug the caller is not
 * a member of AND for a slug that does not exist, deliberately, so that the route is not
 * an existence oracle for every organisation on the deployment. The caller's own org list
 * is the thing they are entitled to see, so it is what distinguishes "empty" from
 * "not yours" — and both of the latter end at the same 404.
 *
 * Next 15: `params` is a Promise.
 */
export default async function OrgProjectsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const [orgs, projects, engines] = await Promise.all([
    listOrganizations(),
    listProjects(orgSlug),
    listEngines(),
  ]);

  const org = orgs.find((candidate) => candidate.slug === orgSlug);
  if (org === undefined) notFound();

  return (
    <AppShell
      nav={orgNavItems(orgSlug)}
      orgLabel={org.name}
      breadcrumb={<span className="truncate">{org.name}</span>}
    >
      <div className="mx-auto max-w-3xl p-8">
        <h1 className="text-lg font-semibold text-text">Projects</h1>
        <p className="mt-1 text-sm text-text-muted">
          {projects.length === 0
            ? 'Nothing here you can open yet.'
            : 'Everything in this organisation you have access to.'}
        </p>
        {projects.length === 0 ? (
          <NoProjects orgId={org.id} orgSlug={orgSlug} engines={engines} />
        ) : (
          <ProjectList orgSlug={orgSlug} projects={projects} />
        )}
      </div>
    </AppShell>
  );
}
