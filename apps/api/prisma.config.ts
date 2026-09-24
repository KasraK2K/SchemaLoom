import { defineConfig } from 'prisma/config';
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';

/**
 * Prisma CLI configuration. Replaces the deprecated `package.json#prisma` key,
 * which Prisma 7 removes.
 *
 * This file exists to solve a real problem, not just to silence the warning.
 * `DATABASE_URL` is DERIVED, not hand-written: docker-compose and the api both
 * read POSTGRES_USER/PASSWORD/DB/PORT, so the connection string cannot drift
 * from the container's actual credentials (doc 01 §10). The api composes it in
 * `src/config/env.ts` — but the Prisma CLI cannot run that file, so without this
 * shim `pnpm db:migrate` fails with "environment variable not found:
 * DATABASE_URL" on a `.env` that is perfectly correct.
 *
 * The derivation here MUST stay identical to `src/config/env.ts`. Both are
 * covered by the same unit test.
 */
loadEnv({ path: resolve(__dirname, '../../.env'), quiet: true });

function databaseUrl(): string {
  const explicit = process.env.DATABASE_URL;
  if (explicit && explicit.length > 0) return explicit;

  const user = encodeURIComponent(process.env.POSTGRES_USER ?? 'schemaloom');
  const password = encodeURIComponent(process.env.POSTGRES_PASSWORD ?? 'schemaloom');
  const db = process.env.POSTGRES_DB ?? 'schemaloom';
  const port = process.env.POSTGRES_PORT ?? '5432';
  const host = process.env.POSTGRES_HOST ?? 'localhost';
  return `postgresql://${user}:${password}@${host}:${port}/${db}`;
}

process.env.DATABASE_URL = databaseUrl();

export default defineConfig({
  schema: resolve(__dirname, 'prisma/schema.prisma'),
  migrations: {
    path: resolve(__dirname, 'prisma/migrations'),
    seed: 'tsx prisma/seed.ts',
  },
});
