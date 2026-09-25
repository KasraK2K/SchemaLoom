import {
  assertE2eDatabase,
  createDatabaseIfAbsent,
  migrate,
  resetDatabase,
} from './fixtures/database';

/**
 * Doc 01 §12.2. Runs BEFORE Playwright starts the two web servers, which is what makes
 * the guard in `assertE2eDatabase` worth having: nothing is created, migrated, seeded or
 * truncated until the database name has been checked.
 *
 * Order is load-bearing. `createDatabaseIfAbsent` connects to `postgres`, not to the
 * target, so it works on a first run. `migrate` then runs every migration including
 * 0003's built-in roles. `resetDatabase` truncates and reseeds, so a rerun starts from
 * the same rows as a first run.
 */
export default function globalSetup(): void {
  const db = assertE2eDatabase(process.env.DATABASE_URL_E2E);

  createDatabaseIfAbsent(db);
  migrate(db);
  resetDatabase(db);

  // The web servers Playwright is about to start read DATABASE_URL, not DATABASE_URL_E2E.
  process.env.DATABASE_URL = db.url;
}
