import { expect, test, type Page } from '@playwright/test';
import { FAKE_ANTHROPIC_URL, signIn, signedInPage, write, type Session } from '../fixtures/api';
import { fetchIr } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Phase 22 (roadmap 22) — describe a feature on a project that has tables. The AI is
 * `scripts/fake-anthropic.ts`: it answers with `invoices` referencing `customers`, and a
 * Refine adds a `status` column. The test checks the request carried the project, and that
 * the imported foreign key points at the EXISTING `customers`, not a copy.
 *
 * Phase 22b — the draft shows on the canvas as ghost tables in a ghost "Billing" card (the
 * fake names that area), Refine replaces them, and Import puts the tables where they were.
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
    // 22b — on the canvas: a ghost table in a ghost card, a dashed line to customers.
    await expect(page.getByTestId('ghost-table')).toHaveCount(1);
    await expect(page.getByTestId('ghost-table')).toContainText('invoices');
    await expect(page.getByTestId('ghost-area')).toContainText('Billing');
    await expect(page.locator('.react-flow__edge-ghostLink')).toHaveCount(1);
  };

  /** Where React Flow drew a ghost, read from its node wrapper's transform. */
  const ghostAt = async (page: Page): Promise<{ key: string; x: number; y: number }> => {
    const key = (await page.getByTestId('ghost-table').getAttribute('data-ghost-key')) ?? '';
    const transform =
      (await page.locator(`.react-flow__node[data-id="ghost:${key}"]`).getAttribute('style')) ?? '';
    const [x, y] = (/translate\(([-\d.]+)px, ?([-\d.]+)px\)/.exec(transform) ?? [])
      .slice(1)
      .map(Number);
    return { key, x: x ?? NaN, y: y ?? NaN };
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

    const first = await ghostAt(page);
    expect(first.x).toBeGreaterThan(0);
    await page.getByLabel('Refine the draft').fill('add a status column');
    await page.getByRole('button', { name: 'Refine' }).click();
    // The ghost is replaced by the refined draft's.
    await expect(page.getByTestId('ghost-table')).toContainText('status');
    await expect(page.getByTestId('ghost-table')).toHaveCount(1);
    expect((await ghostAt(page)).key).not.toBe(first.key);
    // A column added to an existing table shows as a faded row under it.
    await expect(page.getByTestId('pending-columns')).toContainText('billing_email');
    await page.getByText('Show SQL').click();
    await expect(page.getByRole('textbox', { name: 'SQL' })).toHaveValue(/status text/);
    const refined = (await calls()).slice(before + 1);
    expect(refined).toHaveLength(1);
    expect(refined[0]?.messages).toHaveLength(3);
    expect(JSON.stringify(refined[0]?.messages[1])).toContain('CREATE TABLE invoices');
    expect(JSON.stringify(refined[0]?.messages[2])).toContain('add a status column');

    const ghost = await ghostAt(page);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(page.getByTestId('ghost-table')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByRole('complementary', { name: 'Describe with AI' })).toBeHidden();

    const ir = await fetchIr(owner, projectId);
    const byName = new Map(Object.values(ir.objects.entity).map((e) => [e.name, e.id]));
    expect([...byName.keys()].sort()).toEqual(['customers', 'invoices', 'orders']);
    // The table sits where its ghost was, inside the area the draft named.
    const invoices = ir.objects.entity[byName.get('invoices') ?? ''];
    expect(invoices?.position).toEqual({ x: ghost.x, y: ghost.y });
    const billing = Object.values(ir.objects.area).find((a) => a.name === 'Billing');
    expect(invoices?.areaId).toBe(billing?.id);
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
    // The change request's draft gets the ghost's position too, not the origin.
    const proposed = Object.values((await fetchIr(owner, draftId)).objects.entity).find(
      (e) => e.name === 'invoices',
    );
    expect(proposed?.position).not.toEqual({ x: 0, y: 0 });
    // Nothing reaches the project until the change request is merged.
    expect(await names(main)).toEqual(['customers']);
  });
});
