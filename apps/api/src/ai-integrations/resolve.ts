import type { AiProviderType } from './abilities';

/** Roadmap 24 §3.2, with no I/O: `AiRouter` loads the rows, this decides. */
export interface IntegrationRow {
  readonly id: string;
  /** set for a personal integration */
  readonly ownerUserId: string | null;
  readonly source: 'server' | 'custom';
  readonly provider: AiProviderType;
  readonly allowedModels: readonly string[];
}
export interface GrantRow {
  readonly integrationId: string;
  readonly projectId: string | null;
  readonly userId: string | null;
}
/** One ability's choices in this org, already narrowed to project ∈ {null, P}, user ∈ {null, U}. */
export interface ChoiceRow {
  readonly projectId: string | null;
  readonly userId: string | null;
  readonly integrationId: string;
  readonly model: string;
  readonly locked: boolean;
}
export interface ResolveInput {
  readonly userId: string;
  readonly projectId: string;
  /** the org's integrations plus the user's personal ones */
  readonly integrations: readonly IntegrationRow[];
  readonly grants: readonly GrantRow[];
  readonly choices: readonly ChoiceRow[];
  readonly policy: { readonly allowPersonalIntegrations: boolean; readonly personalProviders: readonly string[] };
  /** [] when ANTHROPIC_API_KEY is unset: the server row is then never usable */
  readonly serverModels: readonly string[];
}
export type ResolutionStep = 'project_lock' | 'org_lock' | 'user_project' | 'user' | 'project' | 'org' | 'server';
export type Resolution =
  | { readonly kind: 'ok'; readonly integrationId: string; readonly model: string; readonly step: ResolutionStep }
  | { readonly kind: 'none' }
  | { readonly kind: 'locked_unavailable'; readonly scope: 'project' | 'org' };

export function usableModels(input: ResolveInput, integration: IntegrationRow): readonly string[] {
  return integration.source === 'server' ? input.serverModels : integration.allowedModels;
}

export function isUsable(input: ResolveInput, integration: IntegrationRow): boolean {
  if (usableModels(input, integration).length === 0) return false;
  if (integration.ownerUserId !== null) {
    const { allowPersonalIntegrations, personalProviders } = input.policy;
    return (
      integration.ownerUserId === input.userId &&
      allowPersonalIntegrations &&
      (personalProviders.length === 0 || personalProviders.includes(integration.provider))
    );
  }
  return input.grants.some(
    (g) =>
      g.integrationId === integration.id &&
      (g.projectId === null || g.projectId === input.projectId) &&
      (g.userId === null || g.userId === input.userId),
  );
}

export function resolveChoice(input: ResolveInput): Resolution {
  const byId = new Map(input.integrations.map((i) => [i.id, i]));
  const ok = (c: ChoiceRow | undefined): boolean => {
    const integration = c === undefined ? undefined : byId.get(c.integrationId);
    return (
      c !== undefined &&
      integration !== undefined &&
      isUsable(input, integration) &&
      usableModels(input, integration).includes(c.model)
    );
  };
  const at = (projectId: string | null, userId: string | null) =>
    input.choices.find((c) => c.projectId === projectId && c.userId === userId);
  const P = input.projectId;
  const U = input.userId;

  for (const [scope, row] of [['project', at(P, null)], ['org', at(null, null)]] as const) {
    if (row?.locked !== true) continue;
    if (!ok(row)) return { kind: 'locked_unavailable', scope };
    return { kind: 'ok', integrationId: row.integrationId, model: row.model, step: `${scope}_lock` };
  }
  const steps: readonly [ResolutionStep, ChoiceRow | undefined][] = [
    ['user_project', at(P, U)],
    ['user', at(null, U)],
    ['project', at(P, null)],
    ['org', at(null, null)],
  ];
  for (const [step, row] of steps) {
    if (row !== undefined && ok(row)) return { kind: 'ok', integrationId: row.integrationId, model: row.model, step };
  }
  const server = input.integrations.find((i) => i.source === 'server');
  const model = input.serverModels[0];
  if (server !== undefined && model !== undefined && isUsable(input, server)) {
    return { kind: 'ok', integrationId: server.id, model, step: 'server' };
  }
  return { kind: 'none' };
}
