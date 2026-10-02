import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { InvitesManager } from '@/features/org-settings/invites-manager';
import { MembersManager } from '@/features/org-settings/members-manager';
import { listInvites, listMembers, myUserId } from '@/features/org-settings/org-settings-api';
import { OrgSettingsNav } from '@/features/org-settings/org-settings-nav';
import { listOrganizations } from '@/features/projects';

/**
 * Doc 05 §3.2 — owners, admins and members may list members; only owners and admins
 * change them. A guest gets the same 404 as a missing org. The API re-checks every write.
 */
export default async function OrgMembersPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const org = (await listOrganizations()).find((candidate) => candidate.slug === orgSlug);
  if (org === undefined || org.orgRole === 'guest') notFound();
  const manages = org.orgRole === 'owner' || org.orgRole === 'admin';
  const [members, meId, invites] = await Promise.all([
    listMembers(orgSlug),
    myUserId(),
    manages ? listInvites(orgSlug) : Promise.resolve([]),
  ]);

  return (
    <AppShell
      nav={orgNavItems(orgSlug)}
      orgLabel={org.name}
      breadcrumb={
        <span className="truncate">
          <Link href={`/${orgSlug}`} className="hover:text-text">
            {org.name}
          </Link>{' '}
          / Members
        </span>
      }
    >
      <div className="mx-auto max-w-3xl p-8">
        <OrgSettingsNav orgSlug={orgSlug} orgRole={org.orgRole} current="members" />
        <h1 className="text-lg font-semibold text-text">Members</h1>
        <p className="mt-1 mb-6 text-sm text-text-muted">
          Everyone in {org.name}.
          {manages && ' Invite new people below; they join with the role you pick.'}
        </p>
        <MembersManager orgSlug={orgSlug} orgRole={org.orgRole} meId={meId} members={members} />
        {manages && <InvitesManager orgSlug={orgSlug} orgRole={org.orgRole} invites={invites} />}
      </div>
    </AppShell>
  );
}
