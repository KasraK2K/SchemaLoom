import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Doc 01 §12.2 — `schemaloom_e2e`, owned end to end, and THE GUARD.
 *
 * This module creates a database, runs migrations against it, seeds it and TRUNCATES
 * every table in it. Pointed at a development database it destroys a day's work, and
 * the way that happens is not malice: it is one stale `DATABASE_URL_E2E` in a shell
 * that was exported hours ago for something else.
 *
 * So `assertE2eDatabase` runs FIRST, before anything is created and before Playwright
 * starts, and refuses unless the database name ends in `_e2e`. One assertion, and the
 * class of bug becomes impossible rather than unlikely.
 */

const API_DIR = fileURLToPath(new URL('../../apps/api', import.meta.url));
const SCHEMA = 'prisma/schema.prisma';

/** The suffix that makes a database disposable. Not configurable — that is the point. */
export const E2E_DATABASE_SUFFIX = '_e2e';

export interface E2eDatabase {
  /** The full connection URL, exactly as given. */
  readonly url: string;
  /** The database name, already checked. */
  readonly name: string;
  /** The same server, pointed at `postgres`, for `CREATE DATABASE`. */
  readonly maintenanceUrl: string;
}

/**
 * THROWS unless `raw` names a database whose name ends in `_e2e`. Exported and pure so
 * the guard itself is testable without a server.
 */
export function assertE2eDatabase(raw: string | undefined): E2eDatabase {
  if (raw === undefined || raw === '') {
    throw new Error(
      'DATABASE_URL_E2E is not set. The e2e suite creates, migrates, seeds and truncates ' +
        'its own database and will not guess one.',
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL_E2E is not a valid URL.');
  }

  const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!name.endsWith(E2E_DATABASE_SUFFIX)) {
    throw new Error(
      `Refusing to run: DATABASE_URL_E2E points at "${name}", which does not end in ` +
        `"${E2E_DATABASE_SUFFIX}". This suite TRUNCATES every table in that database. ` +
        'Point it at schemaloom_e2e.',
    );
  }

  const maintenance = new URL(raw);
  maintenance.pathname = '/postgres';
  maintenance.search = '';
  return { url: raw, name, maintenanceUrl: maintenance.toString() };
}

/**
 * `execSync`'s own message names the command; the reason Postgres refused is on the
 * child's stderr, which is where "database already exists" actually lands.
 */
function describeExecError(error: unknown): string {
  if (!(error instanceof Error)) return typeof error === 'string' ? error : '';
  // Every call here sets `encoding: 'utf8'` and pipes both streams, so these are strings
  // when they are anything at all.
  const { stderr, stdout } = error as { stderr?: unknown; stdout?: unknown };
  const asText = (value: unknown): string => (typeof value === 'string' ? value : '');
  return [error.message, asText(stderr), asText(stdout)].join('\n');
}

/** `prisma` from apps/api, with DATABASE_URL pinned to the e2e database. */
function prisma(db: E2eDatabase, args: string, input?: string): string {
  return execSync(`pnpm exec prisma ${args}`, {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: db.url },
    encoding: 'utf8',
    input,
    stdio: input === undefined ? ['ignore', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * `CREATE DATABASE` cannot run inside a transaction and has no `IF NOT EXISTS`, so the
 * "already there" case is read off the error rather than avoided. Everything else
 * rethrows: a permission failure must not be mistaken for success.
 */
export function createDatabaseIfAbsent(db: E2eDatabase): void {
  try {
    execSync(`pnpm exec prisma db execute --url "${db.maintenanceUrl}" --stdin`, {
      cwd: API_DIR,
      encoding: 'utf8',
      input: `CREATE DATABASE "${db.name}";`,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error: unknown) {
    if (!describeExecError(error).includes('already exists')) throw error;
  }
}

export function migrate(db: E2eDatabase): void {
  prisma(db, `migrate deploy --schema ${SCHEMA}`);
}

/**
 * Every table in one statement, so foreign keys never decide the order. `RESTART
 * IDENTITY` matters: a test asserting on an ordinal must not depend on how many times
 * the suite has run today.
 *
 * Two tables are held back on purpose.
 *
 * `_prisma_migrations` — truncating it makes `migrate deploy` replay every migration
 * against a database that already has the objects, which fails on the first
 * `CREATE TABLE`.
 *
 * `roles` — migration 0003 seeds the five built-in roles with FIXED ids that
 * `access_grants.role_id` is a real foreign key to, and `migrate deploy` will NOT
 * re-seed them because `_prisma_migrations` still says 0003 ran. Truncating `roles`
 * therefore leaves every grant in the seed unable to resolve, which surfaces as "this
 * user has no access" three suites later. Custom roles are deleted instead.
 */
export function truncate(db: E2eDatabase): void {
  prisma(
    db,
    `db execute --url "${db.url}" --stdin`,
    `DO $$
DECLARE tables text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
    INTO tables
    FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename NOT IN ('_prisma_migrations', 'roles');
  IF tables IS NOT NULL THEN
    EXECUTE 'TRUNCATE TABLE ' || tables || ' RESTART IDENTITY CASCADE';
  END IF;
  DELETE FROM public.roles WHERE is_built_in = false;
END $$;`,
  );
}

export function seed(db: E2eDatabase): void {
  execSync('pnpm run db:seed', {
    cwd: API_DIR,
    env: { ...process.env, DATABASE_URL: db.url },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Truncate-and-reseed. Global setup calls it once; when suites start writing rows other
 * suites read, hang it off a Playwright `setup` project per suite rather than adding
 * per-test cleanup.
 */
export function resetDatabase(db: E2eDatabase): void {
  truncate(db);
  seed(db);
}
