import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { OrgSettingsNav } from '@/features/org-settings/org-settings-nav';
import { listOrganizations } from '@/features/projects';
import { listRoles } from '@/features/roles/roles-api';
import { RolesManager } from '@/features/roles/roles-manager';

/**
 * Doc 05 §3.2 / §4 — custom roles, owners and admins only. The org list decides who may
 * see the page (anyone else gets the same 404 as a missing org); the API re-checks every
 * write regardless, so this is presentation, not the gate.
 */
export default async function OrgRolesPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const [orgs, roles] = await Promise.all([listOrganizations(), listRoles(orgSlug)]);
  const org = orgs.find((candidate) => candidate.slug === orgSlug);
  if (org === undefined || (org.orgRole !== 'owner' && org.orgRole !== 'admin')) notFound();

  return (
    <AppShell
      nav={orgNavItems(orgSlug)}
      orgLabel={org.name}
      breadcrumb={
        <span className="truncate">
          <Link href={`/${orgSlug}`} className="hover:text-text">
            {org.name}
          </Link>{' '}
          / Roles
        </span>
      }
    >
      <div className="mx-auto max-w-3xl p-8">
        <OrgSettingsNav orgSlug={orgSlug} orgRole={org.orgRole} current="roles" />
        <h1 className="text-lg font-semibold text-text">Roles</h1>
        <p className="mt-1 mb-6 text-sm text-text-muted">
          Custom roles can be used in any grant in {org.name}. Archiving a role hides it from
          the role pickers; people who already hold it keep their access.
        </p>
        <RolesManager orgSlug={orgSlug} roles={roles} />
      </div>
    </AppShell>
  );
}
