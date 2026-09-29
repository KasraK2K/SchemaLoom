import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { GroupsManager } from '@/features/org-settings/groups-manager';
import { listGroups, listMembers } from '@/features/org-settings/org-settings-api';
import { OrgSettingsNav } from '@/features/org-settings/org-settings-nav';
import { listOrganizations } from '@/features/projects';

/** Doc 05 §3.2 — groups: listed by owners, admins and members, managed by owners and admins. */
export default async function OrgGroupsPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const org = (await listOrganizations()).find((candidate) => candidate.slug === orgSlug);
  if (org === undefined || org.orgRole === 'guest') notFound();
  const [groups, members] = await Promise.all([listGroups(orgSlug), listMembers(orgSlug)]);

  return (
    <AppShell
      nav={orgNavItems(orgSlug)}
      orgLabel={org.name}
      breadcrumb={
        <span className="truncate">
          <Link href={`/${orgSlug}`} className="hover:text-text">
            {org.name}
          </Link>{' '}
          / Groups
        </span>
      }
    >
      <div className="mx-auto max-w-3xl p-8">
        <OrgSettingsNav orgSlug={orgSlug} orgRole={org.orgRole} current="groups" />
        <h1 className="text-lg font-semibold text-text">Groups</h1>
        <p className="mt-1 mb-6 text-sm text-text-muted">
          Share a project with a group from its Share dialog and everyone in it gets that access.
        </p>
        <GroupsManager
          orgSlug={orgSlug}
          canManage={org.orgRole === 'owner' || org.orgRole === 'admin'}
          groups={groups}
          members={members}
        />
      </div>
    </AppShell>
  );
}
