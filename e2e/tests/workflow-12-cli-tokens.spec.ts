import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, request, test } from '@playwright/test';
import { API_URL, signIn, signedInPage, write, type Session } from '../fixtures/api';
import { assertE2eDatabase, executeSql } from '../fixtures/database';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Phase 11 §7 step 6 (docs/phase11/DESIGN.md): a token made in the browser drives the built
 * CLI, is fenced to its routes and its project, and stops working once revoked.
 *
 * Needs `pnpm --filter @schemaloom/cli build`. The drift part needs `pg_dump` where the
 * api runs, like workflow 10, and is noted rather than failed without it.
 */

const CLI = fileURLToPath(new URL('../../packages/cli/dist/index.js', import.meta.url));
const tag = String(Date.now());
const SCHEMA = `w12_${tag}`;
const TABLE = 'w12_orders';
const db = assertE2eDatabase(process.env.DATABASE_URL_E2E);

function cli(token: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SCHEMALOOM_URL: API_URL, SCHEMALOOM_TOKEN: token },
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

const bearer = (token: string) => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

test.describe('workflow 12 — API tokens and the CLI', () => {
  let olivia: Session;
  let projectId = '';

  test.beforeAll(async () => {
    olivia = await signIn(SEED_EMAILS.owner);
    const created = await olivia.api.post('/api/projects', {
      headers: write(olivia),
      data: {
        organizationId: SEED.orgId,
        name: `CLI ${tag}`,
        engineId: 'postgresql',
        engineVersion: '16',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    projectId = ((await created.json()) as { id: string }).id;
    const imported = await olivia.api.post(`/api/projects/${projectId}/import`, {
      headers: write(olivia),
      data: { source: `CREATE TABLE ${TABLE} (id bigint PRIMARY KEY, total numeric NOT NULL);` },
    });
    expect(imported.status(), await imported.text()).toBe(201);
  });

  test('create in the browser → pull → fenced → diff → revoke', async ({ browser }) => {
    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}/p/${projectId}`);
    await page.getByRole('button', { name: 'Project settings' }).click();
    await page.getByLabel('Name').fill(`w12 ${tag}`);
    await page.getByLabel('Can also check drift against the saved connection').check();
    await page.getByRole('button', { name: 'Create token' }).click();
    const shown = page.getByRole('status').filter({ hasText: 'Copy it now' });
    await expect(shown).toBeVisible();
    const token = (await shown.locator('code').textContent()) ?? '';
    expect(token).toMatch(/^slt_/);
    await page.keyboard.press('Escape');

    // The CLI, built, against the real api.
    const whoami = cli(token, 'whoami');
    expect(whoami.code, whoami.stderr).toBe(0);
    expect(whoami.stdout).toContain(`CLI ${tag}`);
    const pulled = cli(token, 'pull', '--format', 'ddl');
    expect(pulled.code, pulled.stderr).toBe(0);
    expect(pulled.stdout).toContain(TABLE);

    // Fenced: a write route, another project the owner CAN see, and token management are 404.
    // No cookies, like the CLI: a cookie would bring the CSRF check into play.
    const api = await request.newContext({ baseURL: API_URL });
    const rename = await api.fetch(`/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: bearer(token),
      data: { name: 'renamed by a token' },
    });
    expect(rename.status()).toBe(404);
    const shell = await api.fetch(`/api/projects/${projectId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await shell.json()) as { name: string }).name).toBe(`CLI ${tag}`);
    const other = await api.fetch(`/api/projects/${SEED.projectId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(other.status()).toBe(404);
    const mint = await api.fetch(`/api/me/api-tokens`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mint.status()).toBe(404);

    // Drift against the saved connection: a throwaway schema with one extra column.
    const url = new URL(db.url);
    executeSql(
      db,
      `CREATE SCHEMA "${SCHEMA}"; CREATE TABLE "${SCHEMA}".${TABLE} (id bigint PRIMARY KEY, total numeric NOT NULL, note text);`,
    );
    try {
      const saved = await olivia.api.put(`/api/projects/${projectId}/connection`, {
        headers: write(olivia),
        data: {
          connection: {
            host: url.hostname,
            port: Number(url.port || 5432),
            database: db.name,
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
            sslmode: 'disable',
            schemas: [SCHEMA],
          },
        },
      });
      expect(saved.status(), await saved.text()).toBe(200);
      const diff = cli(token, 'diff', '--fail-on-drift', '--json');
      if (diff.code === 3 && diff.stderr.includes('503')) {
        test
          .info()
          .annotations.push({ type: 'skip', description: 'no pg_dump where the api runs' });
      } else {
        expect(diff.code, diff.stderr).toBe(1);
        expect(diff.stdout).toContain('note');
      }
    } finally {
      executeSql(db, `DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE;`);
    }

    // Revoke on the account page; the CLI is refused from then on (exit 3, not 1).
    await page.goto('/settings/security');
    const row = page.getByRole('listitem').filter({ hasText: `w12 ${tag}` });
    await row.getByRole('button', { name: 'Revoke' }).click();
    await expect(row).toHaveCount(0);
    const after = cli(token, 'whoami');
    expect(after.code).toBe(3);
    expect(after.stderr).toContain('401 invalid_token');
  });
});
