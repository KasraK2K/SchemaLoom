import { expect, test } from '@playwright/test';
import { signedInPage, signIn } from '../fixtures/api';
import { fetchIr, fieldsOf } from '../fixtures/ir';
import { SEED } from '../fixtures/seed-ids';

/**
 * SPEC §8 workflow #3 — the analyst logs in, sees only permitted content, selects
 * `orders` and `customers`, asks for a report, and copies validated SQL.
 *
 * The first half runs today. The AI half needs `POST /api/projects/:id/ai/threads` and
 * the SSE stream, which Phase 1 does not ship; it is `test.fixme` with the assertion
 * that will matter most written out, because it is the one an AI feature is most likely
 * to get wrong: the hidden column's name must not be in the bytes sent to the provider.
 */
test.describe('workflow 3 — the analyst asks for a report', () => {
  test('logs in and lands on the project canvas', async ({ browser }) => {
    const page = await signedInPage(browser, SEED.users.analyst);
    await page.goto(`/${SEED.orgSlug}/p/${SEED.projectId}`);

    // The canvas renders the entity names it was served; `employees` is one of them,
    // because the analyst's grant is project-wide.
    await expect(page.getByText('customers').first()).toBeVisible();
    await expect(page.getByText('orders').first()).toBeVisible();
  });

  test('sees only permitted content: salary is a nameless slot, not a column', async () => {
    const alex = await signIn(SEED.users.analyst);
    const ir = await fetchIr(alex, SEED.projectId);

    const named = fieldsOf(ir, SEED.entities.employees).map((f) => f.name);
    expect(named).toContain('full_name');
    expect(named).not.toContain('salary');
  });

  test('can select the two tables the report is about', async () => {
    const alex = await signIn(SEED.users.analyst);
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
    // Needs POST /api/projects/:id/ai/threads and the SSE stream.
    //
    // The assertion this must carry when it lands (doc 05 §11.4): with a stubbed
    // AiProvider that records its input, assert that the bytes sent to the provider
    // contain "orders" and "customers" and do NOT contain "salary". A masked column the
    // model never saw cannot appear in the SQL it writes.
  });

  test.fixme('AI is refused for a subject without ai:use', () => {
    // Dana holds Editor on Billing with canUseAi = false, so the same route must answer
    // 403 { code: 'forbidden', atom: 'ai:use' } for her. Same route, same project.
  });
});
