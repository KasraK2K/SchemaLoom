'use client';

import { useQuery } from '@tanstack/react-query';
import { AbilityChoices } from './ability-choices';
import { listIntegrations, type IntegrationBase } from './ai-integrations-api';
import { GrantsEditor } from './grants-editor';
import { IntegrationList } from './integration-list';
import { PersonalPolicy } from './personal-policy';

/**
 * The org AI page body. A client component because the list takes a render prop (the grants
 * editor per row), which a server page cannot pass.
 */
export function OrgAiPanel({
  orgSlug,
  members,
  projects,
}: {
  readonly orgSlug: string;
  readonly members: readonly { id: string; label: string }[];
  readonly projects: readonly { id: string; name: string }[];
}) {
  const base: IntegrationBase = { kind: 'org', orgSlug };
  // Same key as the list, so this shares its cache.
  const integrations = useQuery({
    queryKey: ['ai-integrations', base],
    queryFn: () => listIntegrations(base),
  });
  return (
    <>
      <IntegrationList
        base={base}
        expand={(i) => (
          <GrantsEditor
            orgSlug={orgSlug}
            integrationId={i.id}
            members={members}
            projects={projects}
          />
        )}
      />
      <AbilityChoices target={{ kind: 'org', orgSlug }} integrations={integrations.data ?? []} />
      <PersonalPolicy orgSlug={orgSlug} />
    </>
  );
}
