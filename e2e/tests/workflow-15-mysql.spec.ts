import { expect, test } from '@playwright/test';
import { API_URL, signIn, signedInPage, write, type Session } from '../fixtures/api';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Roadmap 9a (`docs/phase9/DESIGN.md`): a MySQL / MariaDB project, end to end through the real
 * api and browser — pick the engine, import a mysqldump-style file with inline comments, open
 * the canvas, and download the DDL export.
 */

const DUMP = `/*!40101 SET NAMES utf8mb4 */;
DROP TABLE IF EXISTS \`customers\`;
CREATE TABLE \`customers\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`email\` varchar(255) NOT NULL COMMENT 'Login address',
  \`status\` enum('active','closed') NOT NULL DEFAULT 'active',
  PRIMARY KEY (\`id\`),
  UNIQUE KEY \`customers_email_uq\` (\`email\`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='People with an account';
CREATE TABLE \`orders\` (
  \`id\` bigint unsigned NOT NULL AUTO_INCREMENT,
  \`customer_id\` bigint unsigned NOT NULL,
  \`total\` decimal(12,2) NOT NULL,
  PRIMARY KEY (\`id\`),
  KEY \`idx_customer_id\` (\`customer_id\`),
  CONSTRAINT \`fk_orders_customer\` FOREIGN KEY (\`customer_id\`) REFERENCES \`customers\` (\`id\`),
  CONSTRAINT \`total_positive\` CHECK ((\`total\` > 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function download(session: Session, projectId: string): Promise<string> {
  const created = await session.api.post(`/api/projects/${projectId}/exports`, {
    headers: write(session),
    data: { format: 'ddl', includeComments: true },
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

test.describe('workflow 15 — a MySQL / MariaDB project', () => {
  test('is offered by the engine picker with MySQL and MariaDB versions', async ({ browser }) => {
    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}`);
    await expect(async () => {
      await page.getByRole('button', { name: 'New project', exact: true }).click();
      await expect(page.getByLabel('Engine')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await page.getByLabel('Engine').selectOption({ label: 'MySQL / MariaDB' });
    const versions = await page.getByLabel('Target version').locator('option').allTextContents();
    expect(versions).toEqual(['MySQL 8.4', 'MySQL 8.0', 'MariaDB 11.4', 'MariaDB 10.11']);
  });

  test('starts a MySQL project from a template, documented', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}`);
    await expect(async () => {
      await page.getByRole('button', { name: 'Choose', exact: true }).click();
      await expect(page.getByLabel('Template')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await page.getByLabel('Engine').selectOption({ label: 'MySQL / MariaDB' });
    await page.getByLabel('Template').selectOption('ecommerce');
    await page.getByLabel('Name', { exact: true }).fill(`MySQL shop ${String(Date.now())}`);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page).toHaveURL(/\/p\/[^/]+$/, { timeout: 60_000 });

    const projectId = page.url().split('/p/')[1] ?? '';
    const project = (await (
      await page.request.get(`${API_URL}/api/projects/${projectId}`)
    ).json()) as {
      engineId: string;
    };
    expect(project.engineId).toBe('mysql');
    const ir = (await (
      await page.request.get(`${API_URL}/api/projects/${projectId}/ir`)
    ).json()) as {
      objects: { entity: Record<string, { name: string }> };
    };
    expect(
      Object.values(ir.objects.entity)
        .map((e) => e.name)
        .sort(),
    ).toEqual(['addresses', 'customers', 'order_items', 'orders', 'payments', 'products']);
    const docs = (await (
      await page.request.get(`${API_URL}/api/projects/${projectId}/docs`)
    ).json()) as {
      docs: { targetType: string }[];
    };
    // Six table comments and four column comments.
    expect(docs.docs.filter((d) => d.targetType !== 'project')).toHaveLength(10);
  });

  test('imports a dump with comments, shows it, and exports MySQL DDL', async ({ browser }) => {
    test.setTimeout(120_000);
    const owner = await signIn(SEED_EMAILS.owner);
    const created = await owner.api.post('/api/projects', {
      headers: write(owner),
      data: {
        organizationId: SEED.orgId,
        name: `MySQL ${String(Date.now())}`,
        engineId: 'mysql',
        engineVersion: 'MySQL 8.4',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const projectId = ((await created.json()) as { id: string }).id;

    const imported = await owner.api.post(`/api/projects/${projectId}/import`, {
      headers: write(owner),
      data: { source: DUMP },
    });
    expect(imported.status(), await imported.text()).toBe(201);
    const body = (await imported.json()) as {
      documented: number;
      report: { statements: { kind: string; status: string }[] };
    };
    expect(
      body.report.statements.filter((s) => s.status !== 'applied' && s.status !== 'ignored'),
    ).toEqual([]);
    expect(body.documented).toBe(2);

    // The canvas renders both tables.
    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}/p/${projectId}`);
    // React Flow renders only the cards in view, so count the tables through the api.
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 30_000 });
    const tables = (await (await owner.api.get(`/api/projects/${projectId}/ir`)).json()) as {
      objects: { entity: Record<string, { name: string }> };
    };
    expect(
      Object.values(tables.objects.entity)
        .map((e) => e.name)
        .sort(),
    ).toEqual(['customers', 'orders']);

    // Docs from the inline comments.
    const docs = (await (await owner.api.get(`/api/projects/${projectId}/docs`)).json()) as {
      docs: { targetType: string; plainText: string }[];
    };
    expect(
      docs.docs
        .filter((d) => d.targetType !== 'project')
        .map((d) => d.plainText)
        .sort(),
    ).toEqual(['Login address', 'People with an account']);

    const sql = await download(owner, projectId);
    expect(sql).toContain('`id` bigint unsigned NOT NULL AUTO_INCREMENT');
    expect(sql).toContain("`status` enum('active','closed') NOT NULL DEFAULT 'active'");
    expect(sql).toContain('UNIQUE KEY `customers_email_uq` (`email`)');
    expect(sql).toContain('CONSTRAINT `total_positive` CHECK (`total` > 0)');
    expect(sql).toContain(
      'ALTER TABLE `orders` ADD CONSTRAINT `fk_orders_customer` FOREIGN KEY (`customer_id`) REFERENCES `customers` (`id`)',
    );
    expect(sql).toContain("ALTER TABLE `customers` COMMENT = 'People with an account'");

    // Same index name on two tables is fine in MySQL (design §5.1).
    const again = await owner.api.post(`/api/projects/${projectId}/import`, {
      headers: write(owner),
      data: {
        source:
          'CREATE TABLE invoices (id INT NOT NULL, customer_id BIGINT UNSIGNED, KEY idx_customer_id (customer_id));',
      },
    });
    expect(again.status(), await again.text()).toBe(201);
    const ir = (await (await owner.api.get(`/api/projects/${projectId}/ir`)).json()) as {
      objects: { index: Record<string, { name: string }> };
    };
    expect(
      Object.values(ir.objects.index).filter((i) => i.name === 'idx_customer_id'),
    ).toHaveLength(2);
  });

  test('9c: a snapshot-to-live migration is MySQL DDL, and says it cannot be rolled back', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const created = await owner.api.post('/api/projects', {
      headers: write(owner),
      data: {
        organizationId: SEED.orgId,
        name: `MySQL migration ${String(Date.now())}`,
        engineId: 'mysql',
        engineVersion: 'MySQL 8.4',
      },
    });
    const projectId = ((await created.json()) as { id: string }).id;
    const imported = await owner.api.post(`/api/projects/${projectId}/import`, {
      headers: write(owner),
      data: { source: DUMP },
    });
    expect(imported.status(), await imported.text()).toBe(201);

    const snapshot = await owner.api.post(`/api/projects/${projectId}/snapshots`, {
      headers: write(owner),
      data: { name: 'before the migration' },
    });
    expect(snapshot.status(), await snapshot.text()).toBe(201);
    const base = ((await snapshot.json()) as { id: string }).id;

    // Change the design: a new column (an additive import) and a renamed table (an op).
    const added = await owner.api.post(`/api/projects/${projectId}/import`, {
      headers: write(owner),
      data: { source: 'CREATE TABLE `orders` (`shipped_at` datetime NULL);' },
    });
    expect(added.status(), await added.text()).toBe(201);
    const ir = (await (await owner.api.get(`/api/projects/${projectId}/ir`)).json()) as {
      objects: { entity: Record<string, { id: string; name: string; version: number }> };
    };
    const customers = Object.values(ir.objects.entity).find((e) => e.name === 'customers');
    const renamed = await owner.api.post(`/api/projects/${projectId}/schema/ops`, {
      headers: write(owner),
      data: {
        batchId: `bat_e2e_w15_${String(Date.now())}`,
        projectId,
        ops: [
          {
            op: 'update',
            type: 'entity',
            id: customers?.id,
            expectedVersion: customers?.version,
            patch: { name: 'clients' },
          },
        ],
        label: 'Rename customers',
      },
    });
    expect(renamed.status(), await renamed.text()).toBe(201);

    const plan = await owner.api.get(`/api/projects/${projectId}/snapshots/${base}/migration/live`);
    expect(plan.status(), await plan.text()).toBe(200);
    const { script } = (await plan.json()) as { script: string };
    expect(script).toContain('cannot be rolled back as a whole');
    expect(script).toContain('RENAME TABLE `customers` TO `clients`;');
    expect(script).toContain(
      'ALTER TABLE `orders` ADD COLUMN `shipped_at` datetime NULL AFTER `total`;',
    );
    expect(script).not.toMatch(/^BEGIN|^COMMIT/m);
  });

  test('9d: a saved query is validated against the MySQL schema', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const created = await owner.api.post('/api/projects', {
      headers: write(owner),
      data: {
        organizationId: SEED.orgId,
        name: `MySQL queries ${String(Date.now())}`,
        engineId: 'mysql',
        engineVersion: 'MariaDB 11.4',
      },
    });
    const projectId = ((await created.json()) as { id: string }).id;
    await owner.api.post(`/api/projects/${projectId}/import`, {
      headers: write(owner),
      data: { source: DUMP },
    });

    const validate = async (query: string) => {
      const response = await owner.api.post(`/api/projects/${projectId}/queries/validate`, {
        headers: write(owner),
        data: { query },
      });
      expect(response.status(), await response.text()).toBe(200);
      return (await response.json()) as {
        parsed: boolean;
        identifiers: { text: string; status: string; suggestions: string[] }[];
      };
    };

    const good = await validate(
      'SELECT c.`email`, COUNT(o.id) FROM customers c LEFT JOIN orders o ON o.customer_id = c.id GROUP BY c.email LIMIT 10',
    );
    expect(good.parsed).toBe(true);
    expect(good.identifiers.filter((i) => i.status !== 'resolved')).toEqual([]);

    const typo = await validate('SELECT emial FROM customers');
    expect(typo.identifiers.find((i) => i.text === 'emial')).toMatchObject({
      status: 'unknown',
      suggestions: ['email'],
    });
  });
});
