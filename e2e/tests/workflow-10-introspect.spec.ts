import { expect, test } from '@playwright/test';
import { signIn, write, type Session } from '../fixtures/api';
import { assertE2eDatabase, executeSql } from '../fixtures/database';
import { fetchIr } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Phase 6 §9 steps 7–8 against the real API: read a live database (a throwaway schema in the
 * e2e database), import it through the ordinary import job, then see a column added in the
 * database show up in the drift check.
 *
 * Needs `pg_dump` where the api runs, and INTROSPECT_ALLOW_PRIVATE_HOSTS=true (the e2e
 * database is on localhost; playwright.config sets it for the servers it starts). Without
 * pg_dump the api answers 503 and the test is skipped rather than failed.
 *
 * Restores the pre-test snapshot and drops the schema at the end, so the seed is exactly as
 * it was for later workflows.
 */

const P = SEED.projectId;
const tag = String(Date.now());
const SCHEMA = `w10_${tag}`;
const TABLE = 'w10_orders';

const db = assertE2eDatabase(process.env.DATABASE_URL_E2E);
const url = new URL(db.url);
const connection = {
  host: url.hostname,
  port: Number(url.port || 5432),
  database: db.name,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  sslmode: 'disable',
  schemas: [SCHEMA],
};

const post = async (session: Session, path: string, data: unknown) =>
  session.api.post(`/api/projects/${P}${path}`, { headers: write(session), data });

const entityNamed = async (session: Session, name: string) =>
  Object.values((await fetchIr(session, P)).objects.entity).find((e) => e.name === name);

test.describe('workflow 10 — read a live database', () => {
  test('introspect → preview → import → drift after a database change', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    executeSql(
      db,
      `CREATE SCHEMA "${SCHEMA}"; CREATE TABLE "${SCHEMA}".${TABLE} (id bigint PRIMARY KEY, total numeric NOT NULL);`,
    );
    const created = await post(owner, '/snapshots', { name: `w10_before_${tag}` });
    expect(created.status(), await created.text()).toBe(201);
    const before = (await created.json()) as { id: string };

    try {
      const preview = await post(owner, '/introspect/preview', { connection });
      test.skip(preview.status() === 503, 'pg_dump is not installed where the api runs');
      expect(preview.status(), await preview.text()).toBe(200);
      const read = (await preview.json()) as {
        preview: { creates: string[] };
        sourceId: string;
        serverVersion: string;
      };
      expect(read.preview.creates).toContain(TABLE);
      expect(read.serverVersion).not.toBe('unknown');
      // Nothing is written by a preview.
      expect(await entityNamed(owner, TABLE)).toBeUndefined();

      const applied = await post(owner, '/introspect/apply', { sourceId: read.sourceId });
      expect(applied.status(), await applied.text()).toBe(201);
      const { id: jobId } = (await applied.json()) as { id: string };
      await expect
        .poll(
          async () => {
            const job = await owner.api.get(`/api/projects/${P}/import/jobs/${jobId}`);
            return ((await job.json()) as { state: string }).state;
          },
          { timeout: 30_000 },
        )
        .toBe('completed');
      expect(await entityNamed(owner, TABLE)).toBeDefined();

      // A source id is single use.
      const replay = await post(owner, '/introspect/apply', { sourceId: read.sourceId });
      expect(replay.status()).toBe(404);

      executeSql(db, `ALTER TABLE "${SCHEMA}".${TABLE} ADD COLUMN w10_note text;`);
      const drift = await post(owner, '/introspect/drift', { connection });
      expect(drift.status(), await drift.text()).toBe(200);
      const { diff, migration } = (await drift.json()) as {
        diff: { entries: { change: string; objectType: string }[] };
        migration: { script: string };
      };
      // The database has a column the design doesn't: going database → design, it's removed.
      expect(diff.entries).toContainEqual(
        expect.objectContaining({ change: 'removed', objectType: 'field' }),
      );
      expect(migration.script).toContain('w10_note');
    } finally {
      const restored = await owner.api.post(`/api/projects/${P}/snapshots/${before.id}/restore`, {
        headers: write(owner),
      });
      expect(restored.status(), await restored.text()).toBe(201);
      await owner.api.delete(`/api/projects/${P}/snapshots/${before.id}`, {
        headers: write(owner),
      });
      executeSql(db, `DROP SCHEMA "${SCHEMA}" CASCADE;`);
    }
  });

  test('a caller without schema:edit cannot read a database', async () => {
    const analyst = await signIn(SEED_EMAILS.analyst);
    const response = await post(analyst, '/introspect/preview', { connection });
    expect([403, 404]).toContain(response.status());
  });
});
