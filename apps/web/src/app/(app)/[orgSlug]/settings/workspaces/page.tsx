import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import {
  listGroups,
  listMembers,
  listWorkspaceGrants,
} from '@/features/org-settings/org-settings-api';
import { OrgSettingsNav } from '@/features/org-settings/org-settings-nav';
import { WorkspaceSharing } from '@/features/org-settings/workspace-sharing';
import { listOrganizations, listWorkspaces } from '@/features/projects';
import { listRoles } from '@/features/roles/roles-api';

/** Roadmap 19 — org owners share whole workspaces (Q2). Anyone else gets a 404. */
export default async function OrgWorkspacesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const org = (await listOrganizations()).find((candidate) => candidate.slug === orgSlug);
  if (org?.orgRole !== 'owner') notFound();
  const [workspaces, members, groups, roles] = await Promise.all([
    listWorkspaces(orgSlug),
    listMembers(orgSlug),
    listGroups(orgSlug),
    listRoles(orgSlug),
  ]);
  const grants = await Promise.all(workspaces.map((w) => listWorkspaceGrants(orgSlug, w.id)));
  const people = [
    // Owners already see everything (R13): a grant to one would do nothing.
    ...members
      .filter((m) => m.role !== 'owner')
      .map((m) => ({ value: `user:${m.userId}`, label: `${m.name} (${m.email})` })),
    ...groups.map((g) => ({ value: `group:${g.id}`, label: `${g.name} (group)` })),
  ];
  const roleOptions = roles
    .filter((r) => !r.archived)
    .map((r) => ({ value: r.key, label: r.name }));

  return (
    <AppShell
      nav={orgNavItems(orgSlug)}
      orgLabel={org.name}
      breadcrumb={
        <span className="truncate">
          <Link href={`/${orgSlug}`} className="hover:text-text">
            {org.name}
          </Link>{' '}
          / Workspaces
        </span>
      }
    >
      <div className="mx-auto max-w-3xl p-8">
        <OrgSettingsNav orgSlug={orgSlug} orgRole={org.orgRole} current="workspaces" />
        <h1 className="text-lg font-semibold text-text">Workspaces</h1>
        <p className="mt-1 mb-6 text-sm text-text-muted">
          Share a whole workspace: the role applies to every project in it, including projects
          created later. A project&rsquo;s own grant for the same person still decides inside that
          project.
        </p>
        <div className="flex flex-col gap-4">
          {workspaces.map((w, i) => (
            <WorkspaceSharing
              key={w.id}
              orgSlug={orgSlug}
              workspace={{ id: w.id, name: w.name }}
              grants={grants[i] ?? []}
              people={people}
              roles={roleOptions}
            />
          ))}
        </div>
      </div>
    </AppShell>
  );
}
