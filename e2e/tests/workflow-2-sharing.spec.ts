import { expect, test } from '@playwright/test';
import { signedInPage, signIn, write } from '../fixtures/api';
import { entityNames, fetchIr, fieldsOf } from '../fixtures/ir';
import { HIDDEN_FROM_FREELANCER, SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * SPEC §8 workflow #2 — the owner shares only the "Billing" Area with a freelancer as
 * Editor, and the whole project with an analyst as Viewer + AI, with salary columns
 * Restricted.
 *
 * The two grants are what the seed writes. The first test performs them again through the
 * access dialog (`apps/web/src/features/sharing`); the rest assert the OUTCOME: doc 05
 * §11.4's freelancer spec, near enough verbatim.
 *
 * The assertion that matters most is the last one, and it is deliberately made on BYTES
 * rather than on rendered text: a name the freelancer may not see must not be in the
 * response at all. A test that only checks the canvas does not render it passes against
 * a server that ships it and hides it in CSS.
 */
test.describe('workflow 2 — an area grant and a project grant, from the receiving end', () => {
  // The seed already holds both grants; `POST /projects/:id/grants` creates OR REPLACES the
  // grant for one (resource, principal), so re-sharing the same values through the dialog
  // leaves the state every other test here reads exactly as it was.
  test('the owner performs both shares in the access dialog', async ({ browser }) => {
    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}/p/${SEED.projectId}`);
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const who = dialog.getByLabel('Add people, groups, or an email address');
    // `has` is matched INSIDE each form, so it must not start from `dialog` again.
    const form = dialog
      .locator('form')
      .filter({ has: page.getByLabel('Add people, groups, or an email address') });
    const saved = () =>
      page.waitForResponse((r) => r.url().endsWith(`/api/projects/${SEED.projectId}/grants`) && r.request().method() === 'POST');

    // Billing only, as Editor, for the freelancer.
    await dialog.getByLabel('Resource to share').selectOption(SEED.areas.billing);
    await who.fill('Dana');
    await dialog.getByRole('button', { name: SEED.users.guest.name, exact: true }).click();
    await form.getByLabel('Role for the new grant').selectOption({ label: 'Editor' });
    let response = saved();
    await form.getByRole('button', { name: /^Save/ }).click();
    expect((await response).status()).toBe(201);

    // The whole project, as Viewer + AI, for the analyst.
    await dialog.getByLabel('Resource to share').selectOption(SEED.projectId);
    await who.fill('Alex');
    await dialog.getByRole('button', { name: SEED.users.member.name, exact: true }).click();
    await form.getByLabel('Role for the new grant').selectOption({ label: 'Viewer' });
    await form.getByLabel('Use AI').check();
    response = saved();
    await form.getByRole('button', { name: /^Save/ }).click();
    expect((await response).status()).toBe(201);

    // The outcome, read back from the API rather than from the dialog's own rendering.
    const olivia = await signIn(SEED_EMAILS.owner);
    const access = (await (await olivia.api.get(`/api/projects/${SEED.projectId}/access`)).json()) as {
      entries: {
        principal: { kind: string; id: string };
        grants: { principal: { id: string }; resourceId: string; roleKey: string; canUseAi: boolean }[];
      }[];
    };
    const own = (userId: string) =>
      access.entries
        .find((e) => e.principal.kind === 'user' && e.principal.id === userId)
        ?.grants.filter((g) => g.principal.id === userId) ?? [];
    expect(own(SEED.users.guest.id)).toEqual([
      expect.objectContaining({ resourceId: SEED.areas.billing, roleKey: 'editor' }),
    ]);
    expect(own(SEED.users.member.id)).toEqual([
      expect.objectContaining({ resourceId: SEED.projectId, roleKey: 'viewer', canUseAi: true }),
    ]);
  });

  test('the freelancer sees Billing and nothing from Catalog', async () => {
    const dana = await signIn(SEED_EMAILS.freelancer);
    const ir = await fetchIr(dana, SEED.projectId);

    expect(entityNames(ir)).toEqual(['customers', 'order_items', 'orders']);
    expect(ir.objects.entity[SEED.entities.products]?.restricted).toBe(true);
    expect(ir.objects.entity[SEED.entities.employees]).toBeUndefined();

    // R-2 / §8.3 — an area survives only on a visible entity or a live atom.
    expect(Object.keys(ir.objects.area)).toEqual([SEED.areas.billing]);
  });

  test('no hidden name reaches the freelancer, anywhere in the payload', async () => {
    const dana = await signIn(SEED_EMAILS.freelancer);
    const response = await dana.api.get(`/api/projects/${SEED.projectId}/ir`);
    const bytes = await response.text();

    for (const name of HIDDEN_FROM_FREELANCER) {
      expect(bytes.includes(name), `leaked "${name}"`).toBe(false);
    }
    // `salary` lives on `employees`, which the freelancer cannot see at all.
    expect(bytes.includes('salary')).toBe(false);
  });

  test('the freelancer may edit inside Billing', async () => {
    const dana = await signIn(SEED_EMAILS.freelancer);
    const ir = await fetchIr(dana, SEED.projectId);
    const orders = ir.objects.entity[SEED.entities.orders];
    expect(orders).toBeDefined();

    const response = await dana.api.post(`/api/projects/${SEED.projectId}/schema/ops`, {
      headers: write(dana),
      data: {
        batchId: `bat_e2e_dana_${String(Date.now())}`,
        projectId: SEED.projectId,
        ops: [
          {
            op: 'update',
            type: 'entity',
            id: SEED.entities.orders,
            expectedVersion: orders?.version ?? 0,
            patch: { color: 'amber' },
          },
        ],
      },
    });
    expect(response.status(), await response.text()).toBe(201);
  });

  // Doc 05 §7.10: 404 vs 403 follows DISCLOSURE, not the grant. `employees` is linked to
  // nothing Dana can see, so it is absent from her model and must 404 like a wrong id.
  // `products` is linked from Billing's order_items and reaches her as a stub (workflow
  // 4), so she already knows it exists and 403 is the honest answer.
  const danaEdits = async (entityId: string) => {
    const dana = await signIn(SEED_EMAILS.freelancer);
    return dana.api.post(`/api/projects/${SEED.projectId}/schema/ops`, {
      headers: write(dana),
      data: {
        batchId: `bat_e2e_dana_denied_${String(Date.now())}`,
        projectId: SEED.projectId,
        ops: [{ op: 'update', type: 'entity', id: entityId, expectedVersion: 0, patch: { color: 'amber' } }],
      },
    });
  };

  test('editing a hidden table is a 404, not a 403 — existence is not disclosed', async () => {
    const response = await danaEdits(SEED.entities.employees);
    expect(response.status(), await response.text()).toBe(404);
    const { error } = (await response.json()) as { error: { code: string } };
    expect(error.code).toBe('not_found');
  });

  test('editing a stubbed Catalog table is a 403 — the stub already disclosed it', async () => {
    const response = await danaEdits(SEED.entities.products);
    expect(response.status(), await response.text()).toBe(403);
    const { error } = (await response.json()) as { error: { code: string } };
    expect(error.code).toBe('object_redacted');
  });

  test('the analyst sees every table, with salary masked and nameless', async () => {
    const alex = await signIn(SEED_EMAILS.analyst);
    const ir = await fetchIr(alex, SEED.projectId);

    expect(entityNames(ir)).toEqual([
      'customers',
      'employees',
      'order_items',
      'orders',
      'products',
    ]);

    const columns = fieldsOf(ir, SEED.entities.employees);
    const salary = columns.find((f) => f.id === SEED.salaryFieldId);
    expect(salary, 'the masked slot must still be there — the gap IS the leak').toBeDefined();
    expect(salary?.restricted).toBe(true);
    expect(salary?.name).toBe('');
    expect(salary?.type.name).toBe('');

    // L22 — dense within the sibling group, so nothing is inferable from a gap.
    expect(columns.map((f) => f.ordinal)).toEqual(columns.map((_, i) => i));
  });

  test('the analyst is read-only: 403 on edit, not 404', async () => {
    const alex = await signIn(SEED_EMAILS.analyst);
    const ir = await fetchIr(alex, SEED.projectId);
    const orders = ir.objects.entity[SEED.entities.orders];

    const response = await alex.api.post(`/api/projects/${SEED.projectId}/schema/ops`, {
      headers: write(alex),
      data: {
        batchId: `bat_e2e_alex_${String(Date.now())}`,
        projectId: SEED.projectId,
        ops: [
          {
            op: 'update',
            type: 'entity',
            id: SEED.entities.orders,
            expectedVersion: orders?.version ?? 0,
            patch: { color: 'amber' },
          },
        ],
      },
    });
    // 403 is right HERE and only here: the analyst can SEE `orders`, so refusing with a
    // 404 would be a lie the client cannot act on.
    expect(response.status(), await response.text()).toBe(403);
    const { error } = (await response.json()) as {
      error: { code: string; details?: { atom?: string } };
    };
    expect(error.code).toBe('forbidden');
    expect(error.details?.atom).toBe('schema:edit');
  });
});
