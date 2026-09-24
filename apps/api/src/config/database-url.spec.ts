import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { deriveDatabaseUrl, type RawEnv } from './database-url';
import { envSchema } from './env';

/**
 * `DATABASE_URL` is derived TWICE: here, for the api, and in `apps/api/prisma.config.ts`,
 * because the Prisma CLI cannot run a Nest module. Nothing in either file makes the two
 * agree — this test does.
 *
 * It does not import `prisma.config.ts` (that file has boot side effects: it loads `.env`
 * and assigns `process.env.DATABASE_URL`). It lifts the `databaseUrl()` function out of
 * the source and runs it against a stub `process`, so the assertion is about the code
 * the Prisma CLI actually executes.
 */
const PRISMA_CONFIG = resolve(__dirname, '../../prisma.config.ts');

function prismaConfigDerivation(): (env: RawEnv) => string {
  const source = readFileSync(PRISMA_CONFIG, 'utf8');
  const match = /function databaseUrl\(\)[\s\S]*?\n\}/.exec(source);
  if (!match) {
    throw new Error(
      `prisma.config.ts no longer declares a top-level \`function databaseUrl()\`. ` +
        `If the derivation moved, move this test with it — the two copies must not drift.`,
    );
  }
  const body = match[0].replace('function databaseUrl(): string {', 'function databaseUrl() {');
  return (env) => runInNewContext(`${body}\ndatabaseUrl();`, { process: { env } }) as string;
}

const CASES: { name: string; env: RawEnv }[] = [
  { name: 'nothing set — every default', env: {} },
  {
    name: 'an explicit DATABASE_URL wins over the parts',
    env: {
      DATABASE_URL: 'postgresql://managed:pw@db.example.com:5432/prod?sslmode=require',
      POSTGRES_USER: 'ignored',
      POSTGRES_PORT: '9999',
    },
  },
  { name: 'an empty DATABASE_URL is not an explicit one', env: { DATABASE_URL: '' } },
  {
    name: 'all four parts customised',
    env: {
      POSTGRES_USER: 'loom',
      POSTGRES_PASSWORD: 'hunter2',
      POSTGRES_DB: 'loomdb',
      POSTGRES_PORT: '6543',
    },
  },
  { name: 'a non-default host', env: { POSTGRES_HOST: 'postgres' } },
  {
    name: 'credentials needing percent-encoding',
    env: { POSTGRES_USER: 'a:b@c', POSTGRES_PASSWORD: 'p@ss w/rd#1' },
  },
];

describe('deriveDatabaseUrl', () => {
  it.each(CASES)('agrees with prisma.config.ts — $name', ({ env }) => {
    expect(deriveDatabaseUrl(env)).toBe(prismaConfigDerivation()(env));
  });

  it('composes the default connection string', () => {
    expect(deriveDatabaseUrl({})).toBe(
      'postgresql://schemaloom:schemaloom@localhost:5432/schemaloom',
    );
  });

  it('percent-encodes user and password but not db or host', () => {
    expect(deriveDatabaseUrl({ POSTGRES_PASSWORD: 'p@ss w/rd' })).toBe(
      'postgresql://schemaloom:p%40ss%20w%2Frd@localhost:5432/schemaloom',
    );
  });
});

describe('envSchema wires the same derivation', () => {
  const base: Record<string, unknown> = {
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

  it('derives DATABASE_URL from the POSTGRES_* parts when unset', () => {
    const parsed = envSchema.parse({ ...base, POSTGRES_DB: 'loomdb', POSTGRES_PORT: '6543' });
    expect(parsed.DATABASE_URL).toBe(
      'postgresql://schemaloom:schemaloom@localhost:6543/loomdb',
    );
  });

  it('passes an explicit DATABASE_URL through untouched', () => {
    const url = 'postgresql://managed:pw@db.example.com:5432/prod?sslmode=require';
    expect(envSchema.parse({ ...base, DATABASE_URL: url }).DATABASE_URL).toBe(url);
  });
});
