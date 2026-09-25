import { expect, test } from '@playwright/test';
import { assertE2eDatabase } from '../fixtures/database';

/**
 * Doc 01 §12.2 — the guard that prevents the accident, under test.
 *
 * `global-setup.ts` creates, migrates, seeds and TRUNCATES the database in
 * `DATABASE_URL_E2E`. Pointed at a dev database it destroys a day's work, and the way
 * that happens is one stale exported variable, not malice. The guard is one assertion;
 * this is the test that keeps someone from "simplifying" it away.
 *
 * It is pure, so it is the one spec here that proves something without a running stack.
 */
test.describe('the _e2e database guard', () => {
  test('refuses a database whose name does not end in _e2e', () => {
    for (const url of [
      'postgresql://u:p@localhost:5432/schemaloom',
      'postgresql://u:p@localhost:5432/schemaloom_dev',
      'postgresql://u:p@localhost:5432/postgres',
      'postgresql://u:p@localhost:5432/schemaloom_e2e_backup',
    ]) {
      expect(() => assertE2eDatabase(url), url).toThrow(/does not end in "_e2e"/);
    }
  });

  test('refuses an unset or unparseable URL rather than guessing one', () => {
    expect(() => assertE2eDatabase(undefined)).toThrow(/not set/);
    expect(() => assertE2eDatabase('')).toThrow(/not set/);
    expect(() => assertE2eDatabase('not a url')).toThrow(/not a valid URL/);
  });

  test('accepts an _e2e database and points maintenance at postgres', () => {
    const db = assertE2eDatabase('postgresql://u:p@localhost:5432/schemaloom_e2e?schema=public');
    expect(db.name).toBe('schemaloom_e2e');
    expect(db.maintenanceUrl).toBe('postgresql://u:p@localhost:5432/postgres');
  });
});
