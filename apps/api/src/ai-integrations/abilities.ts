import type { AI_PROVIDER_IDS } from '@schemaloom/contracts';

/**
 * Roadmap 24 §3.3 — every server-side AI ability. A new AI feature adds one entry here and
 * calls `AiRouter.resolve(…, id)`; it never reads an AI key or model from env.
 */
export const AI_ABILITIES = [
  { id: 'chat', label: 'Assistant chat', strictOutput: false, background: false },
  { id: 'schema_draft', label: 'Describe it, get a schema', strictOutput: true, background: false },
  { id: 'doc_drafts', label: 'Draft docs', strictOutput: true, background: true },
] as const;
export type AiAbility = (typeof AI_ABILITIES)[number]['id'];
export const AI_ABILITY_IDS = AI_ABILITIES.map((a) => a.id) as [AiAbility, ...AiAbility[]];
export const isAiAbility = (s: string): s is AiAbility =>
  (AI_ABILITY_IDS as readonly string[]).includes(s);

export type AiProviderType = (typeof AI_PROVIDER_IDS)[number];

/** §4.2. `thinking` is false off Anthropic: the OpenAI path sends no reasoning_effort (PLAN). */
export const PROVIDER_CAPABILITIES: Record<
  AiProviderType,
  { readonly caching: boolean; readonly thinking: boolean; readonly fallback: boolean }
> = {
  anthropic: { caching: true, thinking: true, fallback: true },
  openai: { caching: true, thinking: false, fallback: false },
  gemini: { caching: true, thinking: false, fallback: false },
  openai_compatible: { caching: false, thinking: false, fallback: false },
};
