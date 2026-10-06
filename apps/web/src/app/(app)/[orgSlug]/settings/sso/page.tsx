import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { OrgSettingsNav } from '@/features/org-settings/org-settings-nav';
import { listGroups, listSsoConnections } from '@/features/org-settings/org-settings-api';
import { SsoSettings } from '@/features/org-settings/sso-settings';
import { listOrganizations } from '@/features/projects';

/** Roadmap 14 §1 — org owners only (Q2); anyone else gets a 404. The api re-checks. */
export default async function OrgSsoPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  const org = (await listOrganizations()).find((candidate) => candidate.slug === orgSlug);
  if (org?.orgRole !== 'owner') notFound();
  const [connections, groups] = await Promise.all([
    listSsoConnections(orgSlug),
    listGroups(orgSlug),
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
          / Single sign-on
        </span>
      }
    >
      <div className="mx-auto max-w-3xl p-8">
        <OrgSettingsNav orgSlug={orgSlug} orgRole={org.orgRole} current="sso" />
        <h1 className="text-lg font-semibold text-text">Single sign-on</h1>
        <p className="mt-1 mb-6 text-sm text-text-muted">
          Let people sign in to {org.name} through your identity provider (Okta, Entra ID, Google
          Workspace, Keycloak…). An identity provider only signs in people of this organisation.
        </p>
        <SsoSettings orgSlug={orgSlug} connections={connections} groups={groups} />
      </div>
    </AppShell>
  );
}
