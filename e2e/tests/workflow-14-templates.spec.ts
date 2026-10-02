import { expect, test } from '@playwright/test';
import { API_URL, signIn, signedInPage, write } from '../fixtures/api';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Roadmap 12 (`docs/phase12/DESIGN.md`) — start from a template on the projects page, and
 * load one (or describe one) from an empty project's canvas. Runs as the seeded owner, in a
 * new project each time, so the shared seed is never touched.
 */

test.describe('workflow 14 — templates and the first-run canvas', () => {
  test('creates a project from the e-commerce template', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}`);

    // A click that lands before React hydrates does nothing; retry until the form opens.
    await expect(async () => {
      await page.getByRole('button', { name: 'Choose', exact: true }).click();
      await expect(page.getByLabel('Template')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });

    await page.getByLabel('Template').selectOption('ecommerce');
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('E-commerce');
    await page.getByLabel('Name', { exact: true }).fill(`Shop ${String(Date.now())}`);
    await page.getByRole('button', { name: 'Create project' }).click();

    await expect(page).toHaveURL(/\/p\/[^/]+$/, { timeout: 60_000 });
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 30_000 });

    const projectId = page.url().split('/p/')[1] ?? '';
    const ir = await page.request.get(`${API_URL}/api/projects/${projectId}/ir`);
    const names = Object.values(
      ((await ir.json()) as { objects: { entity: Record<string, { name: string }> } }).objects
        .entity,
    ).map((e) => e.name);
    expect(names.sort()).toEqual([
      'addresses',
      'customers',
      'order_items',
      'orders',
      'payments',
      'products',
    ]);
  });

  test('an empty project can load a template or describe a schema', async ({ browser }) => {
    test.setTimeout(120_000);
    const owner = await signIn(SEED_EMAILS.owner);
    const created = await owner.api.post('/api/projects', {
      headers: write(owner),
      data: {
        organizationId: SEED.orgId,
        name: `Empty ${String(Date.now())}`,
        engineId: 'postgresql',
        engineVersion: '16',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const projectId = ((await created.json()) as { id: string }).id;

    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}/p/${projectId}`);

    await expect(async () => {
      await page.getByRole('button', { name: 'Describe', exact: true }).click();
      await expect(page.getByLabel('Describe a schema')).toBeFocused({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });

    await page.getByLabel('Load a template').selectOption('blog');
    await expect(page.getByRole('textbox', { name: 'SQL' })).toHaveValue(/CREATE TABLE posts/);
  });

  test('COMMENT ON in imported SQL becomes docs, and a hand-written doc is kept', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const created = await owner.api.post('/api/projects', {
      headers: write(owner),
      data: {
        organizationId: SEED.orgId,
        name: `Comments ${String(Date.now())}`,
        engineId: 'postgresql',
        engineVersion: '16',
      },
    });
    const projectId = ((await created.json()) as { id: string }).id;
    const importSql = (source: string) =>
      owner.api.post(`/api/projects/${projectId}/import`, {
        headers: write(owner),
        data: { source },
      });
    const docs = async () =>
      (
        (await (await owner.api.get(`/api/projects/${projectId}/docs`)).json()) as {
          docs: { targetType: string; plainText: string }[];
        }
      ).docs
        .filter((d) => d.targetType !== 'project')
        .map((d) => d.plainText)
        .sort();

    const first = await importSql(
      'CREATE TABLE orders (id bigint PRIMARY KEY, total numeric);\n' +
        "COMMENT ON TABLE orders IS 'One row per order';\n" +
        "COMMENT ON COLUMN orders.total IS 'Gross, in cents';",
    );
    expect(first.status(), await first.text()).toBe(201);
    expect(((await first.json()) as { documented: number }).documented).toBe(2);
    expect(await docs()).toEqual(['Gross, in cents', 'One row per order']);

    // Re-importing a different comment does not replace the doc that exists.
    const again = await importSql(
      'CREATE TABLE orders (id bigint PRIMARY KEY, total numeric);\n' +
        "COMMENT ON TABLE orders IS 'Something else';",
    );
    expect(((await again.json()) as { documented: number }).documented).toBe(0);
    expect(await docs()).toEqual(['Gross, in cents', 'One row per order']);
  });
});
