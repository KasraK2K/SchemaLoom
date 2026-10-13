import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AppShell } from '@/components/app-shell/app-shell';
import { orgNavItems } from '@/components/app-shell/sidebar';
import { OrgAiPanel } from '@/features/ai-integrations/org-ai-panel';
import { listMembers } from '@/features/org-settings/org-settings-api';
import { OrgSettingsNav } from '@/features/org-settings/org-settings-nav';
import { listOrganizations, listProjects } from '@/features/projects';

/**
 * Roadmap 24 §5.1 — owners and admins connect AI providers, grant them, and pick the model
 * for each feature. Anyone else gets the 404 of a missing page; the api re-checks.
 */
export default async function OrgAiPage({ params }: { params: Promise<{ orgSlug: string }> }) {
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
          / AI
        </span>
      }
    >
      <div className="mx-auto max-w-5xl p-8">
        <OrgSettingsNav orgSlug={orgSlug} orgRole={org.orgRole} current="ai" />
        <h1 className="text-lg font-semibold text-text">AI</h1>
        <p className="mt-1 mb-6 text-sm text-text-muted">
          Connect AI providers, decide who can use them, and pick the model for each AI feature.
        </p>
        <OrgAiPanel
          orgSlug={orgSlug}
          members={members.map((m) => ({ id: m.userId, label: `${m.name} (${m.email})` }))}
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        />
      </div>
    </AppShell>
  );
}
