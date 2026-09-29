import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../config/env';
import type { AuthService } from './auth.service';
import {
  GoogleStrategy,
  googleCallbackUrl,
  googleStrategyProvider,
  isGoogleConfigured,
} from './google.strategy';

function configWith(overrides: Partial<Record<keyof AppEnv, string>>) {
  const env: Partial<Record<keyof AppEnv, string>> = {
    API_PUBLIC_URL: 'http://localhost:3001',
    ...overrides,
  };
  return { get: (key: keyof AppEnv) => env[key] } as unknown as ConfigService<AppEnv, true>;
}

const auth = {} as AuthService;

describe('Google strategy registration', () => {
  it('is ABSENT when neither env var is set', () => {
    const config = configWith({});
    expect(isGoogleConfigured(config)).toBe(false);
    expect(googleStrategyProvider.useFactory(config, auth)).toBeNull();
  });

  it('is absent when only one half is set (env.ts rejects this, belt and braces)', () => {
    expect(googleStrategyProvider.useFactory(configWith({ GOOGLE_CLIENT_ID: 'id' }), auth)).toBe(
      null,
    );
    expect(
      googleStrategyProvider.useFactory(configWith({ GOOGLE_CLIENT_SECRET: 's' }), auth),
    ).toBeNull();
  });

  it('is present when both are set', () => {
    const strategy = googleStrategyProvider.useFactory(
      configWith({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }),
      auth,
    );
    expect(strategy).toBeInstanceOf(GoogleStrategy);
  });

  it('builds the callback URL under the global api prefix', () => {
    expect(googleCallbackUrl('https://api.schemaloom.dev')).toBe(
      'https://api.schemaloom.dev/api/auth/google/callback',
    );
    expect(googleCallbackUrl('https://api.schemaloom.dev/')).toBe(
      'https://api.schemaloom.dev/api/auth/google/callback',
    );
  });
});

describe('GoogleStrategy.validate', () => {
  const strategy = () =>
    new GoogleStrategy(configWith({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' }), {
      upsertOAuthUser: () => Promise.resolve('u1'),
    } as unknown as AuthService);

  const profile = (email: string | undefined, verified: boolean) =>
    ({
      id: 'g1',
      displayName: 'Ada',
      _json: { email, email_verified: verified, name: 'Ada' },
    }) as unknown as Parameters<GoogleStrategy['validate']>[2];

  it('accepts a verified Google address', async () => {
    await expect(strategy().validate('at', 'rt', profile('a@example.com', true))).resolves.toEqual({
      userId: 'u1',
    });
  });

  it('refuses an unverified address — linking is by email', async () => {
    await expect(
      strategy().validate('at', 'rt', profile('a@example.com', false)),
    ).rejects.toThrow();
    await expect(strategy().validate('at', 'rt', profile(undefined, true))).rejects.toThrow();
  });
});
