import { AI_PROVIDER_IDS } from '@schemaloom/contracts';
import { z } from 'zod';
import { apiFetch } from '@/lib/api-client';

export { AI_PROVIDER_IDS };

/** Wire shapes of `apps/api/src/ai-integrations` (roadmap 24 §5.1). Dates arrive as ISO strings. */
const CapabilitiesSchema = z.object({
  caching: z.boolean(),
  thinking: z.boolean(),
  fallback: z.boolean(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

export const IntegrationSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  source: z.enum(['server', 'custom']),
  personal: z.boolean(),
  baseUrl: z.string().nullable(),
  keyHint: z.string().nullable(),
  models: z.array(z.string()),
  status: z.enum(['unchecked', 'ok', 'failing']),
  lastError: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  capabilities: CapabilitiesSchema,
});
export type Integration = z.infer<typeof IntegrationSchema>;
const TestResultSchema = IntegrationSchema.extend({ fetchedModels: z.array(z.string()) });

export const GrantSchema = z.object({
  id: z.string(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  userId: z.string().nullable(),
  userName: z.string().nullable(),
});
export type Grant = z.infer<typeof GrantSchema>;

export const ChoiceSchema = z.object({
  ability: z.string(),
  projectId: z.string().nullable(),
  userId: z.string().nullable(),
  integrationId: z.string(),
  model: z.string(),
  locked: z.boolean(),
});
export type Choice = z.infer<typeof ChoiceSchema>;

/** What a member may pick from: no admin fields (key hint, base URL, status). */
const UsableIntegrationSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  source: z.enum(['server', 'custom']),
  personal: z.boolean(),
  models: z.array(z.string()),
  capabilities: CapabilitiesSchema,
});

export const MeChoicesSchema = z.object({
  choices: z.array(ChoiceSchema),
  usableIntegrations: z.array(UsableIntegrationSchema),
  personalAllowed: z.boolean(),
});

export const AbilitySchema = z.object({ id: z.string(), label: z.string() });
export type Ability = z.infer<typeof AbilitySchema>;

const StepSchema = z.enum([
  'project_lock',
  'org_lock',
  'user_project',
  'user',
  'project',
  'org',
  'server',
]);
export type ResolutionStep = z.infer<typeof StepSchema>;

export const OptionsSchema = z.object({
  abilities: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      strictOutput: z.boolean(),
      resolved: z
        .object({ integrationId: z.string(), model: z.string(), step: StepSchema })
        .nullable(),
      lock: z.object({ scope: z.enum(['project', 'org']), usable: z.boolean() }).nullable(),
    }),
  ),
  integrations: z.array(UsableIntegrationSchema),
});
export type Options = z.infer<typeof OptionsSchema>;

/** Ids come from the API; unknown ones fall back to the raw id. */
const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  openai_compatible: 'OpenAI-compatible',
};
export const providerLabel = (id: string): string => PROVIDER_LABELS[id] ?? id;

export type IntegrationBase = { kind: 'org'; orgSlug: string } | { kind: 'me' };
export type ChoiceTarget =
  | { kind: 'org'; orgSlug: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'me'; orgSlug: string; projectId: string | null };

export function integrationsPath(base: IntegrationBase): string {
  return base.kind === 'org'
    ? `/organizations/${encodeURIComponent(base.orgSlug)}/ai/integrations`
    : '/me/ai/integrations';
}

export function choicesPath(target: ChoiceTarget): string {
  switch (target.kind) {
    case 'org':
      return `/organizations/${encodeURIComponent(target.orgSlug)}/ai/choices`;
    case 'project':
      return `/projects/${encodeURIComponent(target.projectId)}/ai/choices`;
    case 'me': {
      const query = new URLSearchParams({ orgSlug: target.orgSlug });
      if (target.projectId !== null) query.set('projectId', target.projectId);
      return `/me/ai/choices?${query.toString()}`;
    }
  }
}

/** `PUT` body: the `me` route also carries where the choice applies. */
export function choiceBody(
  target: ChoiceTarget,
  input: { ability: string; integrationId: string; model: string; locked: boolean },
) {
  return target.kind === 'me'
    ? { ...input, orgSlug: target.orgSlug, projectId: target.projectId }
    : input;
}

/** "1 model found", "3 models found" */
export const modelsFound = (n: number): string =>
  `${String(n)} ${n === 1 ? 'model' : 'models'} found`;

export function capabilityHints(c: Capabilities): string[] {
  return [
    ...(c.caching ? [] : ['No prompt caching']),
    ...(c.thinking ? [] : ['No extended thinking']),
    ...(c.fallback ? [] : ['No fallback on refusal']),
  ];
}

export function stepLabel(step: ResolutionStep): string {
  switch (step) {
    case 'server':
      return 'Server default';
    case 'org':
      return 'Org default';
    case 'project':
      return 'Project default';
    case 'user':
      return 'Your choice';
    case 'user_project':
      return 'Your choice here';
    case 'org_lock':
    case 'project_lock':
      return 'Set by your admin';
  }
}

export interface IntegrationInput {
  provider?: string;
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string[];
}

const grantsPath = (orgSlug: string, id: string) =>
  `${integrationsPath({ kind: 'org', orgSlug })}/${encodeURIComponent(id)}/grants`;

export async function listIntegrations(base: IntegrationBase): Promise<Integration[]> {
  return IntegrationSchema.array().parse(await apiFetch<unknown>(integrationsPath(base)));
}
export async function createIntegration(base: IntegrationBase, body: IntegrationInput) {
  return IntegrationSchema.parse(
    await apiFetch<unknown>(integrationsPath(base), { method: 'POST', body }),
  );
}
export async function updateIntegration(base: IntegrationBase, id: string, body: IntegrationInput) {
  return IntegrationSchema.parse(
    await apiFetch<unknown>(`${integrationsPath(base)}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body,
    }),
  );
}
export async function deleteIntegration(base: IntegrationBase, id: string): Promise<void> {
  await apiFetch(`${integrationsPath(base)}/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
export async function testIntegration(base: IntegrationBase, id: string) {
  return TestResultSchema.parse(
    await apiFetch<unknown>(`${integrationsPath(base)}/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    }),
  );
}

export async function listGrants(orgSlug: string, id: string): Promise<Grant[]> {
  return GrantSchema.array().parse(await apiFetch<unknown>(grantsPath(orgSlug, id)));
}
export async function addGrant(
  orgSlug: string,
  id: string,
  body: { projectId: string | null; userId: string | null },
) {
  return GrantSchema.parse(
    await apiFetch<unknown>(grantsPath(orgSlug, id), { method: 'POST', body }),
  );
}
export async function removeGrant(orgSlug: string, id: string, grantId: string): Promise<void> {
  await apiFetch(`${grantsPath(orgSlug, id)}/${encodeURIComponent(grantId)}`, {
    method: 'DELETE',
  });
}

export async function listChoices(
  target: Exclude<ChoiceTarget, { kind: 'me' }>,
): Promise<Choice[]> {
  return ChoiceSchema.array().parse(await apiFetch<unknown>(choicesPath(target)));
}
export async function listMyChoices(target: Extract<ChoiceTarget, { kind: 'me' }>) {
  return MeChoicesSchema.parse(await apiFetch<unknown>(choicesPath(target)));
}
export async function putChoice(
  target: ChoiceTarget,
  input: { ability: string; integrationId: string; model: string; locked: boolean },
) {
  const path = choicesPath(target).split('?')[0] ?? '';
  return ChoiceSchema.parse(
    await apiFetch<unknown>(path, { method: 'PUT', body: choiceBody(target, input) }),
  );
}
export async function clearChoice(target: ChoiceTarget, ability: string): Promise<void> {
  const [path = '', query = ''] = choicesPath(target).split('?');
  const params = new URLSearchParams(query);
  params.set('ability', ability);
  await apiFetch(`${path}?${params.toString()}`, { method: 'DELETE' });
}

export async function getOptions(projectId: string): Promise<Options> {
  return OptionsSchema.parse(
    await apiFetch<unknown>(`/projects/${encodeURIComponent(projectId)}/ai/options`),
  );
}
export async function listAbilities(): Promise<Ability[]> {
  const { abilities } = z
    .object({ abilities: AbilitySchema.array() })
    .parse(await apiFetch<unknown>('/ai/abilities'));
  return abilities;
}
