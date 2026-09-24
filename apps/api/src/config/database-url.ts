/**
 * `DATABASE_URL` is DERIVED, not hand-written (doc 01 §10/§11.1): docker-compose and
 * the api both read POSTGRES_USER/PASSWORD/DB/PORT, so the connection string cannot
 * drift from the container's actual credentials.
 *
 * The Prisma CLI cannot run `env.ts`, so `apps/api/prisma.config.ts` carries a second
 * copy of this derivation. The two MUST agree; `database-url.spec.ts` extracts the
 * copy out of `prisma.config.ts` and asserts they produce the same string for the
 * same environment. If you change one, that test fails until you change the other.
 */
export type RawEnv = Record<string, string | undefined>;

export function deriveDatabaseUrl(env: RawEnv): string {
  const explicit = env.DATABASE_URL;
  if (explicit && explicit.length > 0) return explicit;

  const user = encodeURIComponent(env.POSTGRES_USER ?? 'schemaloom');
  const password = encodeURIComponent(env.POSTGRES_PASSWORD ?? 'schemaloom');
  const db = env.POSTGRES_DB ?? 'schemaloom';
  const port = env.POSTGRES_PORT ?? '5432';
  const host = env.POSTGRES_HOST ?? 'localhost';
  return `postgresql://${user}:${password}@${host}:${port}/${db}`;
}
