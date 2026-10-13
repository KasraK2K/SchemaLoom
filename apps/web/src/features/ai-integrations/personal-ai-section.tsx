'use client';

import { useQuery } from '@tanstack/react-query';
import { AbilityChoices } from './ability-choices';
import { listMyChoices } from './ai-integrations-api';
import { IntegrationList } from './integration-list';

/** One org's per-feature choices. The usable list is the API's: it knows the grants and policy. */
function OrgChoices({ org }: { readonly org: { slug: string; name: string } }) {
  // Under the personal list's key, so adding or deleting a personal integration refreshes it.
  const usable = useQuery({
    queryKey: ['ai-integrations', { kind: 'me' }, 'usable', org.slug],
    queryFn: () => listMyChoices({ kind: 'me', orgSlug: org.slug, projectId: null }),
  });
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-text">{org.name}</h3>
      {usable.data?.personalAllowed === false && (
        <p className="text-sm text-text-muted">
          {org.name} doesn’t allow personal AI keys; your choices here use the org’s integrations.
        </p>
      )}
      <AbilityChoices
        target={{ kind: 'me', orgSlug: org.slug, projectId: null }}
        integrations={usable.data?.usableIntegrations ?? []}
      />
    </div>
  );
}

/**
 * Roadmap 24 §5.3 — the signed-in user's own AI integrations, and per organisation which model
 * each feature uses for them. The orgs come from the server page (the list is server-fetched).
 */
export function PersonalAiSection({
  orgs,
}: {
  readonly orgs: readonly { slug: string; name: string }[];
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold text-text">AI integrations</h2>
      <IntegrationList base={{ kind: 'me' }} />
      {orgs.map((org) => (
        <OrgChoices key={org.slug} org={org} />
      ))}
    </section>
  );
}
