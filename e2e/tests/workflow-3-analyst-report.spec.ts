import { expect, test } from '@playwright/test';
import { FAKE_ANTHROPIC_URL, signedInPage, signIn, write } from '../fixtures/api';
import { fetchIr, fieldsOf } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * SPEC §8 workflow #3 — the analyst logs in, sees only permitted content, selects
 * `orders` and `customers`, asks for a report, and copies validated SQL.
 *
 * Everything runs against the real API. The model is `scripts/fake-anthropic.ts`, which
 * records what it was sent, so the key assertion (the hidden column's name is not in the
 * bytes sent to the provider) holds end to end, not just in the service spec.
 */
test.describe('workflow 3 — the analyst asks for a report', () => {
  test('logs in and lands on the project canvas', async ({ browser }) => {
    const page = await signedInPage(browser, SEED_EMAILS.analyst);
    await page.goto(`/${SEED.orgSlug}/p/${SEED.projectId}`);

    // The canvas renders the entity names it was served; `employees` is one of them,
    // because the analyst's grant is project-wide.
    await expect(page.getByText('customers').first()).toBeVisible();
    await expect(page.getByText('orders').first()).toBeVisible();
  });

  test('sees only permitted content: salary is a nameless slot, not a column', async () => {
    const alex = await signIn(SEED_EMAILS.analyst);
    const ir = await fetchIr(alex, SEED.projectId);

    const named = fieldsOf(ir, SEED.entities.employees).map((f) => f.name);
    expect(named).toContain('full_name');
    expect(named).not.toContain('salary');
  });

  test('can select the two tables the report is about', async () => {
    const alex = await signIn(SEED_EMAILS.analyst);
    const ir = await fetchIr(alex, SEED.projectId);

    for (const id of [SEED.entities.orders, SEED.entities.customers]) {
      const entity = ir.objects.entity[id];
      expect(entity, id).toBeDefined();
      expect(entity?.restricted).toBeUndefined();
    }
    // The FK between them survives whole, which is what makes a join suggestible.
    const joins = Object.values(ir.objects.link).filter((l) => l.name !== '');
    expect(joins.length).toBeGreaterThan(0);
  });

  test('asks for ORM code in Code mode; salary never reaches the provider', async ({ browser }) => {
    // The api's Anthropic calls go to `scripts/fake-anthropic.ts`. A reused local dev api
    // is not pointed there (and may hold a real key), so locally this runs only on request.
    test.skip(
      process.env.CI === undefined && process.env.E2E_FAKE_AI === undefined,
      'start the api with ANTHROPIC_BASE_URL=' + FAKE_ANTHROPIC_URL + ', then set E2E_FAKE_AI=1',
    );
    const calls = async (): Promise<unknown[]> =>
      (await (await fetch(`${FAKE_ANTHROPIC_URL}/calls`)).json()) as unknown[];

    const alex = await signIn(SEED_EMAILS.analyst);
    const title = `w3 code ${String(Date.now())}`;
    const created = await alex.api.post(`/api/projects/${SEED.projectId}/ai/threads`, {
      headers: write(alex),
      data: {
        title,
        selection: {
          entityIds: [SEED.entities.orders, SEED.entities.customers, SEED.entities.employees],
          fieldIds: [],
          linkIds: [],
          areaIds: [],
        },
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const threadId = ((await created.json()) as { id: string }).id;
    const before = (await calls()).length;

    const page = await signedInPage(browser, SEED_EMAILS.analyst);
    await page.goto(`/${SEED.orgSlug}/p/${SEED.projectId}`);
    await page.getByRole('tab', { name: 'AI' }).click();
    await page.getByRole('button', { name: title }).click();
    await page.getByRole('radio', { name: 'Code' }).click();

    // Models: the exporter's output for the selection, redacted, no AI call.
    const models = page.getByLabel('Prisma models');
    await expect(models).toContainText('model orders');
    await expect(models).toContainText('full_name');
    await expect(models).not.toContainText('salary');
    expect(await calls()).toHaveLength(before);

    await page
      .getByLabel('What the code should do')
      .fill('Orders over $100 with the customer email');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByLabel('Prisma code')).toContainText('prisma.orders.findMany');
    await page.getByText('Show SQL').click();
    await expect(page.getByText('JOIN customers c')).toBeVisible();

    // What left the api: the selection's names, never the masked column's.
    const sent = (await calls()).slice(before);
    expect(sent).toHaveLength(1);
    const bytes = JSON.stringify(sent[0]);
    for (const name of ['orders', 'customers', 'employees', 'full_name', '<models>'])
      expect(bytes).toContain(name);
    expect(bytes).not.toContain('salary');

    // Stored as a code answer whose SQL twin validated against the seed (L25 ids recorded).
    const thread = (await (await alex.api.get(`/api/ai/threads/${threadId}`)).json()) as {
      messages: {
        role: string;
        code: string | null;
        queryText: string | null;
        metadata: { orm: string | null; usedEntityIds: string[] };
      }[];
    };
    const answer = thread.messages.at(-1);
    expect(answer?.role).toBe('assistant');
    expect(answer?.metadata.orm).toBe('prisma');
    expect(answer?.code).toContain('findMany');
    expect(answer?.queryText).toContain('JOIN customers');
    expect(answer?.metadata.usedEntityIds).toEqual(
      expect.arrayContaining([SEED.entities.orders, SEED.entities.customers]),
    );
  });

  test('AI is refused for a subject without ai:use', async () => {
    // Dana holds Editor on Billing with canUseAi = false. The permission answer comes
    // before the "no API key" 503, so this holds on a server with or without a key.
    const dana = await signIn(SEED_EMAILS.freelancer);
    const response = await dana.api.post(`/api/projects/${SEED.projectId}/ai/threads`, {
      headers: write(dana),
      data: {
        selection: { entityIds: [SEED.entities.orders], fieldIds: [], linkIds: [], areaIds: [] },
      },
    });
    expect(response.status()).toBe(403);
    const body = (await response.json()) as {
      error: { code: string; details?: { atom?: string } };
    };
    expect(body.error.code).toBe('forbidden');
    expect(body.error.details?.atom).toBe('ai:use');
  });
});
