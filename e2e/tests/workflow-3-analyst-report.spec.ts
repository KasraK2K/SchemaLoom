import { expect, test } from '@playwright/test';
import { signedInPage, signIn, write } from '../fixtures/api';
import { fetchIr, fieldsOf } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * SPEC §8 workflow #3 — the analyst logs in, sees only permitted content, selects
 * `orders` and `customers`, asks for a report, and copies validated SQL.
 *
 * The AI refusal runs against the real API (Phase 5). The report itself stays `test.fixme`:
 * it needs a live model, and its key assertion — the hidden column's name is not in the
 * bytes sent to the provider — is a unit test over a recording provider.
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

  test.fixme('asks for a report and copies validated SQL', () => {
    // Still fixme: a real answer needs ANTHROPIC_API_KEY on the e2e server, and the
    // assertion that matters — the bytes sent to the provider contain "orders" and
    // "customers" and NOT "salary" — needs a provider that records its input, which only
    // a unit test can inject. It runs there: `apps/api/src/ai/ai.service.spec.ts`, "sends a
    // context with no hidden or restricted name".
  });

  test('AI is refused for a subject without ai:use', async () => {
    // Dana holds Editor on Billing with canUseAi = false. The permission answer comes
    // before the "no API key" 503, so this holds on a server with or without a key.
    const dana = await signIn(SEED_EMAILS.freelancer);
    const response = await dana.api.post(`/api/projects/${SEED.projectId}/ai/threads`, {
      headers: write(dana),
      data: { selection: { entityIds: [SEED.entities.orders], fieldIds: [], linkIds: [], areaIds: [] } },
    });
    expect(response.status()).toBe(403);
    const body = (await response.json()) as { error: { code: string; details?: { atom?: string } } };
    expect(body.error.code).toBe('forbidden');
    expect(body.error.details?.atom).toBe('ai:use');
  });
});
