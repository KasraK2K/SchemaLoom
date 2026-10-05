import { expect, test, type Page } from '@playwright/test';
import { FAKE_ANTHROPIC_URL, signIn, signedInPage, write, type Session } from '../fixtures/api';
import { fetchIr } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Phase 22 (roadmap 22) — describe a feature on a project that has tables. The AI is
 * `scripts/fake-anthropic.ts`: it answers with `invoices` referencing `customers`, and a
 * Refine adds a `status` column. The test checks the request carried the project, and that
 * the imported foreign key points at the EXISTING `customers`, not a copy.
 */
test.describe.configure({ mode: 'serial' });

test.describe('workflow 21 — describe a feature with AI', () => {
  let owner: Session;
  let projectId: string;

  const calls = async (): Promise<{ system: unknown; messages: { content: unknown }[] }[]> =>
    (await (await fetch(`${FAKE_ANTHROPIC_URL}/calls`)).json()) as {
      system: unknown;
      messages: { content: unknown }[];
    }[];

  test.beforeEach(() => {
    // As workflow 3: a reused local dev api is not pointed at the fake.
    test.skip(
      process.env.CI === undefined && process.env.E2E_FAKE_AI === undefined,
      'start the api with ANTHROPIC_BASE_URL=' + FAKE_ANTHROPIC_URL + ', then set E2E_FAKE_AI=1',
    );
  });

  test.beforeAll(async () => {
    owner = await signIn(SEED_EMAILS.owner);
    const created = await owner.api.post('/api/projects', {
      headers: write(owner),
      data: {
        organizationId: SEED.orgId,
        name: `Describe ${String(Date.now())}`,
        engineId: 'postgresql',
        engineVersion: '16',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    projectId = ((await created.json()) as { id: string }).id;
    const imported = await owner.api.post(`/api/projects/${projectId}/import`, {
      headers: write(owner),
      data: {
        source:
          'CREATE TABLE customers (id uuid PRIMARY KEY, email text NOT NULL);\n' +
          'CREATE TABLE orders (id uuid PRIMARY KEY, placed_at timestamptz NOT NULL, customer_id uuid REFERENCES customers (id));',
      },
    });
    expect(imported.status(), await imported.text()).toBe(201);
  });

  const describe = async (page: Page, project: string, buildOn: string): Promise<void> => {
    await page.goto(`/${SEED.orgSlug}/p/${project}`);
    await expect(async () => {
      await page.getByRole('button', { name: 'Describe with AI' }).click();
      await expect(page.getByLabel('Describe a schema')).toBeFocused({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await expect(page.getByText(buildOn, { exact: true })).toBeVisible();
    await page.getByLabel('Describe a schema').fill('Invoices for our customers');
    await page.getByRole('button', { name: 'Draft SQL with AI' }).click();
    const summary = page.getByRole('list', { name: 'What the draft does' });
    await expect(summary).toContainText('Creates 1 table: `invoices`');
    await expect(summary).toContainText('Links to existing: `customers`');
    await expect(summary).toContainText('invoices.customer_id → customers.id');
  };

  test('drafts with the project in context, refines, and imports onto customers', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const page = await signedInPage(browser, SEED_EMAILS.owner);
    const before = (await calls()).length;
    await describe(page, projectId, 'Builds on your 2 tables');

    const drafted = (await calls()).slice(before);
    expect(drafted).toHaveLength(1);
    const system = JSON.stringify(drafted[0]?.system);
    expect(system).toContain('<schema>');
    expect(system).toContain('T customers');
    expect(system).toContain('Reuse what exists');

    await page.getByLabel('Refine the draft').fill('add a status column');
    await page.getByRole('button', { name: 'Refine' }).click();
    await page.getByText('Show SQL').click();
    await expect(page.getByRole('textbox', { name: 'SQL' })).toHaveValue(/status text/);
    const refined = (await calls()).slice(before + 1);
    expect(refined).toHaveLength(1);
    expect(refined[0]?.messages).toHaveLength(3);
    expect(JSON.stringify(refined[0]?.messages[1])).toContain('CREATE TABLE invoices');
    expect(JSON.stringify(refined[0]?.messages[2])).toContain('add a status column');

    await page.getByRole('button', { name: 'Import', exact: true }).click();
    // The preview may ask whether orders became invoices; Keep both is the default.
    const done = page.getByRole('button', { name: 'Done' });
    await expect(async () => {
      if (await page.getByText('Looks like a rename?').isVisible())
        await page.getByRole('button', { name: 'Import', exact: true }).click();
      await expect(done).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });

    const ir = await fetchIr(owner, projectId);
    const byName = new Map(Object.values(ir.objects.entity).map((e) => [e.name, e.id]));
    expect([...byName.keys()].sort()).toEqual(['customers', 'invoices', 'orders']);
    const links = Object.values(ir.objects.link) as unknown as {
      from: { entityId: string };
      to: { entityId: string };
    }[];
    expect(
      links.some(
        (l) =>
          l.from.entityId === byName.get('invoices') && l.to.entityId === byName.get('customers'),
      ),
    ).toBe(true);
  });

  test('Propose as a change imports the draft into a change request instead', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const created = await owner.api.post('/api/projects', {
      headers: write(owner),
      data: {
        organizationId: SEED.orgId,
        name: `Describe propose ${String(Date.now())}`,
        engineId: 'postgresql',
        engineVersion: '16',
      },
    });
    const main = ((await created.json()) as { id: string }).id;
    const imported = await owner.api.post(`/api/projects/${main}/import`, {
      headers: write(owner),
      data: { source: 'CREATE TABLE customers (id uuid PRIMARY KEY, email text NOT NULL);' },
    });
    expect(imported.status(), await imported.text()).toBe(201);

    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await describe(page, main, 'Builds on your table');
    await page.getByRole('button', { name: 'Propose as a change' }).click();
    await page.waitForURL((url) => !url.pathname.endsWith(`/p/${main}`), { timeout: 30_000 });

    const draftId = decodeURIComponent(page.url().split('/p/')[1]?.split(/[/?#]/)[0] ?? '');
    const names = async (id: string) =>
      Object.values((await fetchIr(owner, id)).objects.entity).map((e) => e.name);
    expect(await names(draftId)).toContain('invoices');
    // Nothing reaches the project until the change request is merged.
    expect(await names(main)).toEqual(['customers']);
  });
});
