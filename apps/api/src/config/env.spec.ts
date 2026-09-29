import { describe, expect, it } from 'vitest';
import { envSchema, validateEnv } from './env';

/** A minimal environment that passes: every `Req. yes` row of doc 01 §11.1. */
const REQUIRED: Record<string, string> = {
  API_PUBLIC_URL: 'http://localhost:3001',
  WEB_PUBLIC_URL: 'http://localhost:3000',
  REDIS_URL: 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  CSRF_SECRET: 'c'.repeat(48),
  SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  MAIL_FROM: 'SchemaLoom <no-reply@schemaloom.local>',
  SMTP_URL: 'smtp://localhost:1025',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'schemaloom',
  S3_ACCESS_KEY_ID: 'schemaloom',
  S3_SECRET_ACCESS_KEY: 'schemaloom-dev-secret',
};

function env(overrides: Record<string, string | undefined> = {}): Record<string, unknown> {
  return { ...REQUIRED, ...overrides };
}

describe('envSchema — a valid environment', () => {
  it('accepts the minimal required set and applies §11.1 defaults', () => {
    const parsed = envSchema.parse(env());

    expect(parsed.NODE_ENV).toBe('development');
    expect(parsed.PORT).toBe(3001);
    expect(parsed.LOG_LEVEL).toBe('info');
    expect(parsed.REDIS_KEY_PREFIX).toBe('sl:');
    expect(parsed.ACCESS_TOKEN_TTL).toBe('15m');
    expect(parsed.REFRESH_TOKEN_TTL).toBe('30d');
    expect(parsed.COOKIE_SECURE).toBe(false);
    expect(parsed.COOKIE_DOMAIN).toBeUndefined();
    expect(parsed.TRUST_PROXY).toBe(0);
  });

  it('defaults CORS_ORIGINS to WEB_PUBLIC_URL and splits an explicit list', () => {
    expect(envSchema.parse(env()).CORS_ORIGINS).toEqual(['http://localhost:3000']);
    expect(
      envSchema.parse(env({ CORS_ORIGINS: 'https://a.dev, https://b.dev ,' })).CORS_ORIGINS,
    ).toEqual(['https://a.dev', 'https://b.dev']);
  });

  it('defaults S3_PUBLIC_URL to S3_ENDPOINT', () => {
    expect(envSchema.parse(env()).S3_PUBLIC_URL).toBe('http://localhost:9000');
  });

  it('treats a present-but-empty optional variable as unset', () => {
    // `RESEND_API_KEY=` in .env must not count as "Resend configured".
    const parsed = envSchema.parse(env({ RESEND_API_KEY: '', COOKIE_DOMAIN: '' }));
    expect(parsed.RESEND_API_KEY).toBeUndefined();
    expect(parsed.COOKIE_DOMAIN).toBeUndefined();
  });

  it('coerces PORT from its string form', () => {
    expect(envSchema.parse(env({ PORT: '4000' })).PORT).toBe(4000);
  });
});

describe('envSchema — each missing required variable', () => {
  for (const key of Object.keys(REQUIRED)) {
    it(`rejects a missing ${key}`, () => {
      const result = envSchema.safeParse(env({ [key]: undefined }));
      expect(result.success).toBe(false);
      const paths = result.error?.issues.map((i) => i.path.join('.')) ?? [];
      // SMTP_URL's absence is reported by the mail cross-field rule, on that path.
      expect(paths).toContain(key);
    });
  }
});

describe('envSchema — §11.4 cross-field rules', () => {
  it('requires RESEND_API_KEY or SMTP_URL', () => {
    const result = envSchema.safeParse(env({ SMTP_URL: undefined }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('RESEND_API_KEY or SMTP_URL');
  });

  it('accepts RESEND_API_KEY alone', () => {
    expect(envSchema.safeParse(env({ SMTP_URL: undefined, RESEND_API_KEY: 're_x' })).success).toBe(
      true,
    );
  });

  for (const provider of ['GOOGLE', 'GITHUB'] as const) {
    it(`treats ${provider} id and secret as both-or-neither`, () => {
      expect(envSchema.safeParse(env({ [`${provider}_CLIENT_ID`]: 'id' })).success).toBe(false);
      expect(envSchema.safeParse(env({ [`${provider}_CLIENT_SECRET`]: 's' })).success).toBe(false);
      expect(
        envSchema.safeParse(
          env({ [`${provider}_CLIENT_ID`]: 'id', [`${provider}_CLIENT_SECRET`]: 's' }),
        ).success,
      ).toBe(true);
    });
  }

  it('requires COOKIE_SECURE when NODE_ENV=production', () => {
    const bad = envSchema.safeParse(env({ NODE_ENV: 'production', COOKIE_SECURE: 'false' }));
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['COOKIE_SECURE']);

    // Unset in production defaults to true rather than failing.
    expect(envSchema.parse(env({ NODE_ENV: 'production' })).COOKIE_SECURE).toBe(true);
    expect(
      envSchema.parse(env({ NODE_ENV: 'production', COOKIE_SECURE: 'true' })).COOKIE_SECURE,
    ).toBe(true);
  });

  it('requires the api and web app on one hostname, ports aside', () => {
    expect(() =>
      envSchema.parse(
        env({
          API_PUBLIC_URL: 'https://api.example.com',
          WEB_PUBLIC_URL: 'https://app.example.com',
        }),
      ),
    ).toThrow(/same hostname/);
    expect(() =>
      envSchema.parse(
        env({
          API_PUBLIC_URL: 'https://app.example.com',
          WEB_PUBLIC_URL: 'https://app.example.com',
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a refresh secret equal to the access secret', () => {
    const same = 'z'.repeat(48);
    const result = envSchema.safeParse(env({ JWT_ACCESS_SECRET: same, JWT_REFRESH_SECRET: same }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['JWT_REFRESH_SECRET']);
  });

  it('rejects a SECRETS_ENCRYPTION_KEY that is not 32 bytes of base64', () => {
    const result = envSchema.safeParse(
      env({ SECRETS_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a JWT secret under 32 characters', () => {
    expect(envSchema.safeParse(env({ JWT_ACCESS_SECRET: 'short' })).success).toBe(false);
  });
});

describe('validateEnv', () => {
  it('returns the parsed environment', () => {
    expect(validateEnv(env()).PORT).toBe(3001);
  });

  it('throws listing EVERY offending variable, not just the first', () => {
    let message = '';
    try {
      validateEnv(env({ REDIS_URL: undefined, S3_BUCKET: undefined, MAIL_FROM: undefined }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('REDIS_URL');
    expect(message).toContain('S3_BUCKET');
    expect(message).toContain('MAIL_FROM');
  });
});
