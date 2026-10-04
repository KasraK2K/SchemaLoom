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
 *  same thing. Without this, `MAILGUN_API_KEY=` would count as "Mailgun configured". */
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
    // Proxy hops in front of the api (load balancer = 1). 0 trusts none: `req.ip` is the
    // socket peer. Too high lets a client spoof X-Forwarded-For past the per-IP limits.
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

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
    // Roadmap 16: `invite` lets only the first account sign up freely; everyone after needs
    // an invitation. A hosted deploy that welcomes new teams sets `open`.
    SIGNUP_MODE: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.enum(['invite', 'open']).default('invite'),
    ),

    // oauth — both-or-neither per provider
    GOOGLE_CLIENT_ID: optionalStr,
    GOOGLE_CLIENT_SECRET: optionalStr,
    GITHUB_CLIENT_ID: optionalStr,
    GITHUB_CLIENT_SECRET: optionalStr,

    // mail
    MAIL_FROM: z.string().min(1),
    // Mailgun's HTTP API; both-or-neither. MAILGUN_API_URL is https://api.eu.mailgun.net
    // for a domain in the EU region.
    MAILGUN_API_KEY: optionalStr,
    MAILGUN_DOMAIN: optionalStr,
    MAILGUN_API_URL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.url().default('https://api.mailgun.net'),
    ),
    SMTP_URL: optionalStr,

    // object storage
    S3_ENDPOINT: z.url(),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_PUBLIC_URL: optionalStr,

    // Phase 5: without a key every AI route answers 503 ai_not_configured
    ANTHROPIC_API_KEY: optionalStr,
    AI_MODEL: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.string().default('claude-sonnet-5-5'),
    ),

    // Phase 6 §3: reading a live database. Private hosts are refused unless a self-hosted
    // install opts in. PG_DUMP_PATH is read by the PostgreSQL engine (PATH when unset).
    INTROSPECTION_ENABLED: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.stringbool().default(true),
    ),
    INTROSPECT_ALLOW_PRIVATE_HOSTS: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.stringbool().default(false),
    ),
    PG_DUMP_PATH: optionalStr,
    // Phase 13 §5: an uploaded database file (SQLite), read for its schema only. Q4.
    INTROSPECT_UPLOAD_MAX_BYTES: z.preprocess(
      (v) => (v === '' ? undefined : v),
      z.coerce.number().int().positive().default(100_000_000),
    ),
  })
  .superRefine((env, ctx) => {
    // §11.4: a mail provider is required. Boot fails if neither Mailgun nor SMTP is set.
    if (Boolean(env.MAILGUN_API_KEY) !== Boolean(env.MAILGUN_DOMAIN)) {
      ctx.addIssue({
        code: 'custom',
        path: ['MAILGUN_DOMAIN'],
        message: 'MAILGUN_API_KEY and MAILGUN_DOMAIN are both-or-neither',
      });
    }
    if (!env.MAILGUN_API_KEY && !env.SMTP_URL) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message: 'set MAILGUN_API_KEY + MAILGUN_DOMAIN or SMTP_URL (MailModule has no provider)',
      });
    }

    // §11.4: Google id and secret are both-or-neither. Same pattern for GitHub.
    for (const provider of ['GOOGLE', 'GITHUB'] as const) {
      const id = provider === 'GOOGLE' ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID;
      const secret = provider === 'GOOGLE' ? env.GOOGLE_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET;
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

    // The session cookies are host-only on the API's host, and the web server forwards the
    // browser's cookies when it renders a page. On two hostnames the web server never gets
    // `sl_access` and every signed-in page loops back to /login, so both must share one
    // (ports may differ: cookies ignore them). Proxy /api and /socket.io to the api.
    if (new URL(env.API_PUBLIC_URL).hostname !== new URL(env.WEB_PUBLIC_URL).hostname) {
      ctx.addIssue({
        code: 'custom',
        path: ['API_PUBLIC_URL'],
        message:
          'must have the same hostname as WEB_PUBLIC_URL (serve /api and /socket.io from the web host)',
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
