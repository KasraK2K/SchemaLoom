import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { GeneralSettings } from '@/features/org-settings/general-settings';
import { getOrgSettings } from '@/features/org-settings/org-settings-api';
import { OrgSettingsNav } from '@/features/org-settings/org-settings-nav';
import { listOrganizations } from '@/features/projects';

/** Docs/phase17/ORG-DEFAULT.md — owners and admins; anyone else gets the same 404 as a missing org. */
export default async function OrgGeneralPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const org = (await listOrganizations()).find((candidate) => candidate.slug === orgSlug);
  if (org === undefined || (org.orgRole !== 'owner' && org.orgRole !== 'admin')) notFound();
  const settings = await getOrgSettings(orgSlug);

  return (
    <AppShell
      nav={orgNavItems(orgSlug)}
      orgLabel={org.name}
      breadcrumb={
        <span className="truncate">
          <Link href={`/${orgSlug}`} className="hover:text-text">
            {org.name}
          </Link>{' '}
          / General
        </span>
      }
    >
      <div className="mx-auto max-w-3xl p-8">
        <OrgSettingsNav orgSlug={orgSlug} orgRole={org.orgRole} current="general" />
        <h1 className="mb-6 text-lg font-semibold text-text">General</h1>
        <GeneralSettings orgSlug={orgSlug} settings={settings} />
      </div>
    </AppShell>
  );
}
