import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { WaitingOnYou } from '@/features/notifications/waiting-on-you';
import {
  NoProjects,
  ProjectList,
  listEngines,
  listOrgTemplates,
  listOrganizations,
  listProjects,
  listWorkspaces,
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
  const [orgs, projects, engines, workspaces, orgTemplates] = await Promise.all([
    listOrganizations(),
    listProjects(orgSlug),
    listEngines(),
    listWorkspaces(orgSlug),
    listOrgTemplates(orgSlug),
  ]);

  const org = orgs.find((candidate) => candidate.slug === orgSlug);
  if (org === undefined) notFound();
  const engineNames = Object.fromEntries(engines.map((e) => [e.id, e.displayName]));

  return (
    <AppShell
      nav={orgNavItems(orgSlug)}
      orgLabel={org.name}
      breadcrumb={<span className="truncate">{org.name}</span>}
    >
      <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-8 md:py-8">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-text">Projects</h1>
            <p className="mt-1 text-sm text-text-muted">
              {projects.length > 0
                ? 'Everything in this organisation you have access to.'
                : org.orgRole === 'guest'
                  ? 'Nothing here you can open yet.'
                  : 'No projects yet. Pick a way to start.'}
            </p>
          </div>
          {org.orgRole !== 'guest' && (
            <Link
              href={`/${orgSlug}/settings/members`}
              className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-hover"
            >
              Settings
            </Link>
          )}
        </header>
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex min-w-0 flex-col gap-6">
            {projects.length > 0 && (
              <ProjectList
                orgSlug={orgSlug}
                projects={projects}
                engineNames={engineNames}
                orgName={org.name}
                orgTemplates={orgTemplates}
              />
            )}
            {/* Doc 05 §3.2: a guest cannot create projects; the API would refuse anyway. */}
            {org.orgRole !== 'guest' && (
              <section aria-label="Start a project">
                {projects.length > 0 && (
                  <h2 className="mb-2 text-sm font-semibold text-text">Start a new project</h2>
                )}
                <NoProjects
                  orgId={org.id}
                  orgSlug={orgSlug}
                  engines={engines}
                  workspaces={workspaces}
                  canManageWorkspaces={org.orgRole === 'owner' || org.orgRole === 'admin'}
                  importTargets={projects.filter(
                    (p) => p.role === 'editor' || p.role === 'manager',
                  )}
                  orgTemplates={orgTemplates}
                  compact={projects.length > 0}
                />
              </section>
            )}
          </div>
          <aside className="flex flex-col gap-4">
            <WaitingOnYou />
          </aside>
        </div>
      </div>
    </AppShell>
  );
}
