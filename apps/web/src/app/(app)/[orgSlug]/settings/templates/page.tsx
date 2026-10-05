import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { OrgSettingsNav } from '@/features/org-settings/org-settings-nav';
import { TemplatesManager } from '@/features/org-settings/templates-manager';
import { listEngines, listOrgTemplates, listOrganizations } from '@/features/projects';

/** Roadmap 12c §2.1 — the org's templates. Rename and delete: the saver, owners and admins. */
export default async function OrgTemplatesPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const org = (await listOrganizations()).find((candidate) => candidate.slug === orgSlug);
  if (org === undefined || org.orgRole === 'guest') notFound();
  const [templates, engines] = await Promise.all([listOrgTemplates(orgSlug), listEngines()]);

  return (
    <AppShell
      nav={orgNavItems(orgSlug)}
      orgLabel={org.name}
      breadcrumb={
        <span className="truncate">
          <Link href={`/${orgSlug}`} className="hover:text-text">
            {org.name}
          </Link>{' '}
          / Templates
        </span>
      }
    >
      <div className="mx-auto max-w-3xl p-8">
        <OrgSettingsNav orgSlug={orgSlug} orgRole={org.orgRole} current="templates" />
        <h1 className="text-lg font-semibold text-text">Templates</h1>
        <p className="mt-1 mb-6 text-sm text-text-muted">
          Projects saved as starting points for everyone here who can create projects. Save one from
          a project&rsquo;s menu on the projects page. Changing a template never touches projects
          already made from it.
        </p>
        <TemplatesManager
          orgSlug={orgSlug}
          templates={templates}
          engineNames={Object.fromEntries(engines.map((e) => [e.id, e.displayName]))}
        />
      </div>
    </AppShell>
  );
}
