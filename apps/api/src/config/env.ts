import { z } from 'zod';
import { deriveDatabaseUrl } from './database-url';

/**
 * Doc 01 §11.1 is the complete list of variables the api may read, and §11.4 says a
 * bad environment must throw BEFORE the Nest container is built. `validateEnv` is
 * wired as `ConfigModule.forRoot({ validate })`, which Nest runs during module
 * metadata evaluation — so the process exits with the list of offending variables
 * instead of an `undefined is not a function` twenty seconds later.
 *
 * Variables deliberately absent (doc 01 §11.1, "five rows deleted"): S3_REGION,
 * S3_FORCE_PATH_STYLE, RATE_LIMIT_WINDOW_SEC, RATE_LIMIT_MAX, TOTP_ISSUER. They are
 * consts next to their consumers. If it is not in `.env.example`, no task may read it.
 */

/** An unset optional variable and one present-but-empty (`FOO=` in `.env`) are the
 *  same thing. Without this, `RESEND_API_KEY=` would count as "Resend configured". */
const optionalStr = z.preprocess((v) => (v === '' ? undefined : v), z.string().optional());

const secret32 = z.string().min(32, 'must be at least 32 characters');

export const envSchema = z
  .object({
    // runtime
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3001),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    // public URLs
    API_PUBLIC_URL: z.url(),
    WEB_PUBLIC_URL: z.url(),
    CORS_ORIGINS: optionalStr,

    // postgres — DATABASE_URL is derived from the parts (see ./database-url)
    POSTGRES_USER: z.string().default('schemaloom'),
    POSTGRES_PASSWORD: z.string().default('schemaloom'),
    POSTGRES_DB: z.string().default('schemaloom'),
    POSTGRES_PORT: z.string().default('5432'),
    POSTGRES_HOST: z.string().default('localhost'),
    DATABASE_URL: optionalStr,
    DATABASE_URL_TEST: optionalStr,

    // redis
    REDIS_URL: z.string().min(1),
    REDIS_URL_TEST: optionalStr,
    REDIS_KEY_PREFIX: z.string().min(1).default('sl:'),

    // auth
    JWT_ACCESS_SECRET: secret32,
    JWT_REFRESH_SECRET: secret32,
    CSRF_SECRET: z.string().min(1),
    SECRETS_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').byteLength === 32, 'must be 32 bytes, base64'),
    ACCESS_TOKEN_TTL: z.string().min(1).default('15m'),
    REFRESH_TOKEN_TTL: z.string().min(1).default('30d'),
    COOKIE_DOMAIN: optionalStr,
    COOKIE_SECURE: z.preprocess((v) => (v === '' ? undefined : v), z.stringbool().optional()),

    // oauth — both-or-neither per provider
    GOOGLE_CLIENT_ID: optionalStr,
    GOOGLE_CLIENT_SECRET: optionalStr,
    GITHUB_CLIENT_ID: optionalStr,
    GITHUB_CLIENT_SECRET: optionalStr,

    // mail
    MAIL_FROM: z.string().min(1),
    RESEND_API_KEY: optionalStr,
    SMTP_URL: optionalStr,

    // object storage
    S3_ENDPOINT: z.url(),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_PUBLIC_URL: optionalStr,

    // Phase 2; the AI module is not registered without it
    ANTHROPIC_API_KEY: optionalStr,
  })
  .superRefine((env, ctx) => {
    // §11.4: "RESEND_API_KEY or SMTP_URL". Boot fails if both are missing.
    if (!env.RESEND_API_KEY && !env.SMTP_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message: 'one of RESEND_API_KEY or SMTP_URL is required (MailModule has no provider)',
      });
    }

    // §11.4: Google id and secret are both-or-neither. Same pattern for GitHub.
    for (const provider of ['GOOGLE', 'GITHUB'] as const) {
      const id = provider === 'GOOGLE' ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID;
      const secret =
        provider === 'GOOGLE' ? env.GOOGLE_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET;
      if (Boolean(id) !== Boolean(secret)) {
        ctx.addIssue({
          code: 'custom',
          path: [`${provider}_CLIENT_SECRET`],
          message: `${provider}_CLIENT_ID and ${provider}_CLIENT_SECRET are both-or-neither`,
        });
      }
    }

    // §11.4: COOKIE_SECURE must be true when NODE_ENV === 'production'.
    if (env.NODE_ENV === 'production' && env.COOKIE_SECURE === false) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true when NODE_ENV=production',
      });
    }

    // §11.1: the refresh secret is distinct "so a leak of one does not mint the other".
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['JWT_REFRESH_SECRET'],
        message: 'must differ from JWT_ACCESS_SECRET',
      });
    }
  })
  .transform((env) => ({
    ...env,
    /** Derived, never hand-written — see ./database-url. */
    DATABASE_URL: deriveDatabaseUrl({
      DATABASE_URL: env.DATABASE_URL,
      POSTGRES_USER: env.POSTGRES_USER,
      POSTGRES_PASSWORD: env.POSTGRES_PASSWORD,
      POSTGRES_DB: env.POSTGRES_DB,
      POSTGRES_PORT: env.POSTGRES_PORT,
      POSTGRES_HOST: env.POSTGRES_HOST,
    }),
    /** Comma-separated allow-list; defaults to WEB_PUBLIC_URL. */
    CORS_ORIGINS: (env.CORS_ORIGINS ?? env.WEB_PUBLIC_URL)
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
    S3_PUBLIC_URL: env.S3_PUBLIC_URL ?? env.S3_ENDPOINT,
  }));

export type AppEnv = z.infer<typeof envSchema>;

/**
 * `ConfigModule.forRoot({ validate })`. Throws with every offending variable listed,
 * not just the first, because a half-configured `.env` is fixed in one pass or three.
 */
export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const result = envSchema.safeParse(raw);
  if (result.success) return result.data;

  const lines = result.error.issues.map(
    (issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  throw new Error(`Invalid environment (${String(lines.length)} problem(s)):\n${lines.join('\n')}`);
}
