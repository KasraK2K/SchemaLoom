import { describe, expect, it } from 'vitest';
import {
  capabilityHints,
  choicesPath,
  integrationsPath,
  MeChoicesSchema,
  modelsFound,
  stepLabel,
} from './ai-integrations-api';

describe('ai-integrations-api', () => {
  it('builds the paths per owner', () => {
    expect(integrationsPath({ kind: 'org', orgSlug: 'acme co' })).toBe(
      '/organizations/acme%20co/ai/integrations',
    );
    expect(integrationsPath({ kind: 'me' })).toBe('/me/ai/integrations');
    expect(choicesPath({ kind: 'project', projectId: 'p1' })).toBe('/projects/p1/ai/choices');
    expect(choicesPath({ kind: 'me', orgSlug: 'acme', projectId: 'p1' })).toBe(
      '/me/ai/choices?orgSlug=acme&projectId=p1',
    );
    expect(choicesPath({ kind: 'me', orgSlug: 'acme', projectId: null })).toBe(
      '/me/ai/choices?orgSlug=acme',
    );
  });
  it('words what a provider lacks', () => {
    expect(capabilityHints({ caching: true, thinking: true, fallback: true })).toEqual([]);
    expect(capabilityHints({ caching: false, thinking: false, fallback: false })).toEqual([
      'No prompt caching',
      'No extended thinking',
      'No fallback on refusal',
    ]);
  });
  it('labels where a choice came from', () => {
    expect(stepLabel('server')).toBe('Server default');
    expect(stepLabel('org_lock')).toBe('Set by your admin');
    expect(stepLabel('user_project')).toBe('Your choice here');
  });
  it('counts models in the singular and plural', () => {
    expect(modelsFound(1)).toBe('1 model found');
    expect(modelsFound(3)).toBe('3 models found');
  });
  it('reads the slim /me usable list', () => {
    const parsed = MeChoicesSchema.parse({
      choices: [],
      personalAllowed: false,
      usableIntegrations: [
        {
          id: 'i',
          name: 'N',
          provider: 'openai',
          source: 'custom',
          personal: false,
          models: ['m'],
          capabilities: { caching: true, thinking: false, fallback: false },
        },
      ],
    });
    expect(parsed.usableIntegrations[0]).not.toHaveProperty('keyHint');
  });
});
