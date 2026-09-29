import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../config/env';
import type { AuthService } from './auth.service';
import {
  GitHubStrategy,
  githubCallbackUrl,
  githubStrategyProvider,
  isGitHubConfigured,
} from './github.strategy';

function configWith(overrides: Partial<Record<keyof AppEnv, string>>) {
  const env: Partial<Record<keyof AppEnv, string>> = {
    API_PUBLIC_URL: 'http://localhost:3001',
    ...overrides,
  };
  return { get: (key: keyof AppEnv) => env[key] } as unknown as ConfigService<AppEnv, true>;
}

describe('GitHub strategy registration', () => {
  it('is absent unless both env vars are set', () => {
    expect(isGitHubConfigured(configWith({}))).toBe(false);
    expect(
      githubStrategyProvider.useFactory(configWith({ GITHUB_CLIENT_ID: 'id' }), {} as AuthService),
    ).toBeNull();
    expect(
      githubStrategyProvider.useFactory(
        configWith({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's' }),
        {} as AuthService,
      ),
    ).toBeInstanceOf(GitHubStrategy);
  });

  it('builds the callback URL under the global api prefix', () => {
    expect(githubCallbackUrl('https://api.schemaloom.dev/')).toBe(
      'https://api.schemaloom.dev/api/auth/github/callback',
    );
  });
});

describe('GitHubStrategy.validate', () => {
  const linked: string[] = [];
  const strategy = new GitHubStrategy(
    configWith({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 's' }),
    {
      upsertOAuthUser: ({ email }: { email: string }) => {
        linked.push(email);
        return Promise.resolve('u1');
      },
    } as unknown as AuthService,
  );
  const profile = (emails: { value: string; primary?: boolean; verified?: boolean }[]) =>
    ({ id: 'gh1', displayName: 'Ada', username: 'ada', emails }) as unknown as Parameters<
      GitHubStrategy['validate']
    >[2];

  it('links by the verified primary address only', async () => {
    await expect(
      strategy.validate(
        'at',
        'rt',
        profile([
          { value: 'other@example.com', primary: false, verified: true },
          { value: 'ada@example.com', primary: true, verified: true },
        ]),
      ),
    ).resolves.toEqual({ userId: 'u1' });
    expect(linked).toEqual(['ada@example.com']);
  });

  it('refuses an unverified primary even when a secondary is verified', async () => {
    await expect(
      strategy.validate(
        'at',
        'rt',
        profile([
          { value: 'victim@example.com', primary: true, verified: false },
          { value: 'mine@example.com', primary: false, verified: true },
        ]),
      ),
    ).rejects.toThrow();
  });
});
