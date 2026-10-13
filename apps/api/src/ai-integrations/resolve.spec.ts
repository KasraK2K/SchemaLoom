import { describe, expect, it } from 'vitest';
import { resolveChoice, type ChoiceRow, type IntegrationRow, type ResolveInput } from './resolve';

const U = 'usr_u';
const P = 'prj_p';
const SERVER: IntegrationRow = {
  id: 'srv',
  ownerUserId: null,
  source: 'server',
  provider: 'anthropic',
  allowedModels: [],
};
const AZURE: IntegrationRow = {
  id: 'az',
  ownerUserId: null,
  source: 'custom',
  provider: 'openai_compatible',
  allowedModels: ['gpt-x', 'gpt-y'],
};
const MINE: IntegrationRow = {
  id: 'mine',
  ownerUserId: U,
  source: 'custom',
  provider: 'openai',
  allowedModels: ['gpt-m'],
};

const base = (over: Partial<ResolveInput> = {}): ResolveInput => ({
  userId: U,
  projectId: P,
  integrations: [SERVER, AZURE, MINE],
  grants: [
    { integrationId: 'srv', projectId: null, userId: null },
    { integrationId: 'az', projectId: null, userId: null },
  ],
  choices: [],
  policy: { allowPersonalIntegrations: true, personalProviders: [] },
  serverModels: ['claude-sonnet-5-5'],
  ...over,
});
const choice = (c: Partial<ChoiceRow>): ChoiceRow => ({
  projectId: null,
  userId: null,
  integrationId: 'az',
  model: 'gpt-x',
  locked: false,
  ...c,
});

describe('resolveChoice (roadmap 24 §3.2)', () => {
  it.each([
    [
      'project lock',
      [
        choice({ projectId: P, locked: true, model: 'gpt-y' }),
        choice({ projectId: P, userId: U, integrationId: 'mine', model: 'gpt-m' }),
      ],
      'project_lock',
      'gpt-y',
    ],
    [
      'org lock beats member choices',
      [choice({ locked: true }), choice({ userId: U, integrationId: 'mine', model: 'gpt-m' })],
      'org_lock',
      'gpt-x',
    ],
    [
      'member in project',
      [
        choice({ projectId: P, userId: U, integrationId: 'mine', model: 'gpt-m' }),
        choice({ userId: U, model: 'gpt-y' }),
      ],
      'user_project',
      'gpt-m',
    ],
    [
      'member everywhere',
      [choice({ userId: U, model: 'gpt-y' }), choice({ projectId: P })],
      'user',
      'gpt-y',
    ],
    ['project default', [choice({ projectId: P, model: 'gpt-y' }), choice({})], 'project', 'gpt-y'],
    ['org default', [choice({})], 'org', 'gpt-x'],
    ['server default', [], 'server', 'claude-sonnet-5-5'],
  ] as const)('%s wins', (_name, choices, step, model) => {
    expect(resolveChoice(base({ choices: [...choices] }))).toMatchObject({
      kind: 'ok',
      step,
      model,
    });
  });

  it('a project lock outranks an org lock', () => {
    const r = resolveChoice(
      base({
        choices: [choice({ locked: true }), choice({ projectId: P, locked: true, model: 'gpt-y' })],
      }),
    );
    expect(r).toMatchObject({ step: 'project_lock', model: 'gpt-y' });
  });

  it('an unusable lock is an error, never a fall-through', () => {
    const r = resolveChoice(
      base({
        grants: [{ integrationId: 'srv', projectId: null, userId: null }],
        choices: [choice({ locked: true })],
      }),
    );
    expect(r).toEqual({ kind: 'locked_unavailable', scope: 'org' });
  });

  it('skips a revoked grant and a removed model', () => {
    const revoked = resolveChoice(
      base({
        grants: [{ integrationId: 'srv', projectId: null, userId: null }],
        choices: [choice({})],
      }),
    );
    expect(revoked).toMatchObject({ step: 'server' });
    const removed = resolveChoice(base({ choices: [choice({ model: 'gone' })] }));
    expect(removed).toMatchObject({ step: 'server' });
  });

  it('matches grants by project, member, and member in project only', () => {
    const only = (g: { projectId: string | null; userId: string | null }) =>
      resolveChoice(
        base({ serverModels: [], grants: [{ integrationId: 'az', ...g }], choices: [choice({})] }),
      ).kind;
    expect(only({ projectId: P, userId: null })).toBe('ok');
    expect(only({ projectId: null, userId: U })).toBe('ok');
    expect(only({ projectId: P, userId: U })).toBe('ok');
    expect(only({ projectId: 'prj_other', userId: null })).toBe('none');
    expect(only({ projectId: null, userId: 'usr_other' })).toBe('none');
    expect(only({ projectId: P, userId: 'usr_other' })).toBe('none');
  });

  it('personal integrations follow the org policy', () => {
    const mineChoice = [choice({ userId: U, integrationId: 'mine', model: 'gpt-m' })];
    expect(
      resolveChoice(
        base({
          choices: mineChoice,
          policy: { allowPersonalIntegrations: false, personalProviders: [] },
        }),
      ),
    ).toMatchObject({ step: 'server' });
    expect(
      resolveChoice(
        base({
          choices: mineChoice,
          policy: { allowPersonalIntegrations: true, personalProviders: ['anthropic'] },
        }),
      ),
    ).toMatchObject({ step: 'server' });
    expect(
      resolveChoice(
        base({
          choices: mineChoice,
          policy: { allowPersonalIntegrations: true, personalProviders: ['openai'] },
        }),
      ),
    ).toMatchObject({ step: 'user' });
  });

  it('someone else’s personal integration is never usable', () => {
    const theirs: IntegrationRow = { ...MINE, id: 'theirs', ownerUserId: 'usr_other' };
    const r = resolveChoice(
      base({
        integrations: [SERVER, theirs],
        choices: [choice({ userId: U, integrationId: 'theirs', model: 'gpt-m' })],
      }),
    );
    expect(r).toMatchObject({ step: 'server' });
  });

  it('the server row needs an env key', () => {
    expect(resolveChoice(base({ serverModels: [] }))).toEqual({ kind: 'none' });
  });
});
