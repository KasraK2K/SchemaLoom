import { expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { signIn, signedInPage, write, type Session } from '../fixtures/api';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Rows 8, 7b, 18 and 13 against the real API and browser: ORM exports, Prisma import, the AI
 * panel's model code, and a SQLite project read from an uploaded `.db` file (in the browser,
 * then compared through the upload drift route).
 */

async function createProject(session: Session, engineId: string, engineVersion: string) {
  const created = await session.api.post('/api/projects', {
    headers: write(session),
    data: {
      organizationId: SEED.orgId,
      name: `w17 ${engineId} ${String(Date.now())}`,
      engineId,
      engineVersion,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

async function exported(session: Session, projectId: string, format: string): Promise<string> {
  const created = await session.api.post(`/api/projects/${projectId}/exports`, {
    headers: write(session),
    data: { format },
  });
  expect(created.status(), await created.text()).toBe(201);
  let job = (await created.json()) as { id: string; status: string; downloadUrl?: string };
  await expect
    .poll(
      async () => {
        job = (await (await session.api.get(`/api/exports/${job.id}`)).json()) as typeof job;
        return job.status;
      },
      { timeout: 30_000 },
    )
    .toBe('done');
  return (await session.api.get(job.downloadUrl ?? '')).text();
}

const tableNames = async (session: Session, projectId: string): Promise<string[]> => {
  const ir = (await (await session.api.get(`/api/projects/${projectId}/ir`)).json()) as {
    objects: { entity: Record<string, { name: string }> };
  };
  return Object.values(ir.objects.entity)
    .map((e) => e.name)
    .sort();
};

const SQL =
  'CREATE TABLE customers (id bigint PRIMARY KEY, name text NOT NULL);\n' +
  'CREATE TABLE orders (id bigint PRIMARY KEY, customer_id bigint NOT NULL REFERENCES customers (id), total numeric(12,2) NOT NULL);';

test.describe('workflow 17 — ORM code and SQLite', () => {
  test('exports every ORM and renders model code for a selection', async () => {
    test.setTimeout(120_000);
    const owner = await signIn(SEED_EMAILS.owner);
    const projectId = await createProject(owner, 'postgresql', '16');
    const imported = await owner.api.post(`/api/projects/${projectId}/import`, {
      headers: write(owner),
      data: { source: SQL },
    });
    expect(imported.status(), await imported.text()).toBe(201);

    expect(await exported(owner, projectId, 'prisma')).toContain('model orders {');
    expect(await exported(owner, projectId, 'drizzle')).toContain('pgTable(');
    expect(await exported(owner, projectId, 'typeorm')).toContain('@Entity(');
    expect(await exported(owner, projectId, 'django')).toContain('models.Model');

    const code = await owner.api.post(`/api/projects/${projectId}/orm-code`, {
      headers: write(owner),
      data: { orm: 'drizzle', entityIds: [] },
    });
    expect(code.status(), await code.text()).toBe(200);
    const body = (await code.json()) as { text: string; incomplete: boolean };
    expect(body.text).toContain('pgTable(');
    expect(body.incomplete).toBe(false);
  });

  test('imports a Prisma schema', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const projectId = await createProject(owner, 'postgresql', '16');
    const source = [
      'model Author {',
      '  id    Int    @id @default(autoincrement())',
      '  name  String',
      '  posts Post[]',
      '}',
      '',
      'model Post {',
      '  id       Int    @id @default(autoincrement())',
      '  title    String',
      '  authorId Int',
      '  author   Author @relation(fields: [authorId], references: [id])',
      '}',
    ].join('\n');
    const imported = await owner.api.post(`/api/projects/${projectId}/import`, {
      headers: write(owner),
      data: { source, format: 'prisma' },
    });
    expect(imported.status(), await imported.text()).toBe(201);
    expect(await tableNames(owner, projectId)).toEqual(['Author', 'Post']);
  });

  test('reads an uploaded SQLite file in the browser, then sees no drift', async ({ browser }) => {
    test.setTimeout(120_000);
    const dir = mkdtempSync(join(tmpdir(), 'w17-'));
    const file = join(dir, 'app.db');
    try {
      const db = new DatabaseSync(file);
      db.exec(
        'CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);' +
          'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers (id), total REAL NOT NULL CHECK (total >= 0));' +
          'CREATE INDEX idx_orders_customer ON orders (customer_id);' +
          'CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 100;',
      );
      db.close();

      const owner = await signIn(SEED_EMAILS.owner);
      const projectId = await createProject(owner, 'sqlite', '3.45');

      const page = await signedInPage(browser, SEED_EMAILS.owner);
      await page.goto(`/${SEED.orgSlug}/p/${projectId}`);
      // An empty project offers import as a card on the canvas.
      await expect(async () => {
        await page.getByRole('button', { name: 'Import', exact: true }).click();
        await expect(page.getByRole('button', { name: 'From a database' })).toBeVisible({
          timeout: 1_000,
        });
      }).toPass({ timeout: 30_000 });
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'From a database' }).click();
      await dialog.getByLabel('Database file').setInputFiles(file);
      await dialog.getByRole('button', { name: 'Import', exact: true }).click();
      await expect
        .poll(() => tableNames(owner, projectId), { timeout: 30_000 })
        .toEqual(['big_orders', 'customers', 'orders']);

      // The same file again: nothing to change.
      const drift = await owner.api.post(`/api/projects/${projectId}/introspect/upload/drift`, {
        headers: { ...write(owner), 'content-type': 'application/octet-stream' },
        data: readFileSync(file),
      });
      expect(drift.status(), await drift.text()).toBe(200);
      const view = (await drift.json()) as { diff: { entries: unknown[] } };
      expect(view.diff.entries).toEqual([]);

      // Not a database: refused before anything is read.
      const junk = await owner.api.post(`/api/projects/${projectId}/introspect/upload/preview`, {
        headers: { ...write(owner), 'content-type': 'application/octet-stream' },
        data: Buffer.from('not a database'),
      });
      expect(junk.status()).toBeGreaterThanOrEqual(400);
      expect(junk.status()).toBeLessThan(500);

      // A SQLite project has no saved connections.
      const saved = await owner.api.put(`/api/projects/${projectId}/connection`, {
        headers: write(owner),
        data: { connection: {} },
      });
      expect(saved.status(), await saved.text()).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
