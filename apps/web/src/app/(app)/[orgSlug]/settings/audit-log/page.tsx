import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { AuditLog } from '@/features/org-settings/audit-log';
import { listMembers } from '@/features/org-settings/org-settings-api';
import { OrgSettingsNav } from '@/features/org-settings/org-settings-nav';
import { listOrganizations, listProjects } from '@/features/projects';

/**
 * Roadmap 14 §2 — owners and admins read the audit log. Anyone else gets the 404 of a missing
 * page; the api re-checks, and leaves an admin's invisible projects out (R13).
 */
export default async function OrgAuditLogPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const org = (await listOrganizations()).find((candidate) => candidate.slug === orgSlug);
  if (org === undefined || (org.orgRole !== 'owner' && org.orgRole !== 'admin')) notFound();
  const [members, projects] = await Promise.all([listMembers(orgSlug), listProjects(orgSlug)]);

  return (
    <AppShell
      nav={orgNavItems(orgSlug)}
      orgLabel={org.name}
      breadcrumb={
        <span className="truncate">
          <Link href={`/${orgSlug}`} className="hover:text-text">
            {org.name}
          </Link>{' '}
          / Audit log
        </span>
      }
    >
      <div className="mx-auto max-w-5xl p-8">
        <OrgSettingsNav orgSlug={orgSlug} orgRole={org.orgRole} current="audit-log" />
        <h1 className="text-lg font-semibold text-text">Audit log</h1>
        <p className="mt-1 mb-6 text-sm text-text-muted">
          Sign-ins, membership, access and settings changes in {org.name}, newest first.
          {org.orgRole === 'admin' && ' Events in projects you can’t open are not shown.'}
        </p>
        <AuditLog
          orgSlug={orgSlug}
          people={members.map((m) => ({ id: m.userId, label: `${m.name} (${m.email})` }))}
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        />
      </div>
    </AppShell>
  );
}
