import { expect, request, test } from '@playwright/test';
import { API_URL, signIn, write } from '../fixtures/api';
import { fetchIr, type Ir } from '../fixtures/ir';
import { HIDDEN_FROM_FREELANCER, SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * SPEC §8 workflow #4 — a guest opens an invite link, sees only the shared tables, and
 * links to hidden tables render as restricted STUBS.
 *
 * The stub behaviour is asserted through the org guest with an area-only grant, and then
 * again through a real share-link session on the same area: the same code path in
 * `VisibilityFilter` with a different subject.
 */
test.describe('workflow 4 — hidden neighbours render as stubs, not as holes', () => {
  test('a link into a hidden table survives as a nameless stub', async () => {
    const dana = await signIn(SEED_EMAILS.freelancer);
    const ir = await fetchIr(dana, SEED.projectId);

    // `order_items.product_id -> products`: order_items is in Billing and visible,
    // products is in Catalog and is not. Dropping the row would leave the edge dangling
    // and the canvas would silently lose a relationship the schema really has.
    const stub = ir.objects.entity[SEED.entities.products];
    expect(stub, 'products must survive as a stub, not vanish').toBeDefined();
    expect(stub?.restricted).toBe(true);
    expect(stub?.name).toBe('');
    expect(stub?.engineProps).toEqual({});

    // RECONCILIATION R-2 — a stub carries its REAL id (so "Request access" has a target)
    // and the project's DEFAULT namespace, never its own.
    expect(stub?.id).toBe(SEED.entities.products);
    expect(stub?.areaId).toBeNull();
    const defaultNamespace = Object.values(ir.objects.namespace).find((n) => n.name === 'public');
    expect(stub?.namespaceId).toBe(defaultNamespace?.id);
  });

  test('a stub has no fields, and the edge to it is badged, not named', async () => {
    const dana = await signIn(SEED_EMAILS.freelancer);
    const ir = await fetchIr(dana, SEED.projectId);

    const stubFields = Object.values(ir.objects.field).filter(
      (f) => f.entityId === SEED.entities.products,
    );
    expect(stubFields, 'a stub entity has no columns at all').toEqual([]);

    const toStub = Object.values(ir.objects.link).filter((l) => l.restricted === true);
    expect(toStub.length, 'the FK into the stub must survive, badged').toBeGreaterThan(0);
    for (const link of toStub) {
      expect(link.name).toBe('');
      expect(link.engineProps).toEqual({});
    }
  });

  test('an entity with no surviving edge is absent entirely, not stubbed', async () => {
    const dana = await signIn(SEED_EMAILS.freelancer);
    const ir = await fetchIr(dana, SEED.projectId);

    // `employees` is in no area and nothing visible links to it. A stub for it would be
    // an existence disclosure bought for nothing.
    expect(ir.objects.entity[SEED.entities.employees]).toBeUndefined();
  });

  /**
   * Doc 05 §12.2(a). A password-protected link on Billing is the freelancer's view with
   * no account at all — and the R17 ceiling plus the R21 allow-list mean a link subject
   * can read and do nothing else, however generous its grant.
   */
  test('a link visitor unlocks Billing and gets the same view, read-only', async ({ browser }) => {
    const owner = await signIn(SEED_EMAILS.owner);
    const created = await owner.api.post(`/api/projects/${SEED.projectId}/share-links`, {
      headers: write(owner),
      data: { resourceType: 'area', resourceId: SEED.areas.billing, expiresAt: null, password: 'billing-only-1' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { link, url } = (await created.json()) as { link: { id: string }; url: string };
    const token = url.slice(url.lastIndexOf('/s/') + 3);

    try {
      const visitor = await request.newContext({ baseURL: API_URL });

      // Every dead end is one uniform 404; the live one only says a password is needed.
      expect((await visitor.get('/api/s/not-a-real-token')).status()).toBe(404);
      const inspect = await visitor.get(`/api/s/${token}`);
      expect(await inspect.json()).toEqual({ needsPassword: true });

      const wrong = await visitor.post(`/api/s/${token}/unlock`, { data: { password: 'nope-nope' } });
      expect(wrong.status()).toBe(401);
      const right = await visitor.post(`/api/s/${token}/unlock`, { data: { password: 'billing-only-1' } });
      expect(right.status(), await right.text()).toBe(200);
      expect(await right.json()).toMatchObject({ projectId: SEED.projectId, resourceId: SEED.areas.billing });

      // Same redaction as Dana's area grant: stub, not hole; hidden names absent as BYTES.
      const irResponse = await visitor.get(`/api/projects/${SEED.projectId}/ir`);
      expect(irResponse.status()).toBe(200);
      const bytes = await irResponse.text();
      for (const name of HIDDEN_FROM_FREELANCER) expect(bytes.includes(name), `leaked "${name}"`).toBe(false);
      const ir = JSON.parse(bytes) as Ir;
      expect(ir.objects.entity[SEED.entities.products]?.restricted).toBe(true);
      expect(ir.objects.entity[SEED.entities.employees]).toBeUndefined();

      // R21: every route outside the allow-list does not exist for a link subject — 404,
      // not 403. "Who has access" is the one a public link must never reach.
      expect((await visitor.get(`/api/projects/${SEED.projectId}/access`)).status()).toBe(404);
      // A write never gets as far as the guard: `sl_session` is authority, so CSRF
      // refuses a write that carries it without the double-submit echo.
      const edit = await visitor.post(`/api/projects/${SEED.projectId}/schema/ops`, {
        data: { batchId: 'bat_e2e_link_write', projectId: SEED.projectId, ops: [] },
      });
      expect(edit.status()).toBe(403);

      // The real page: unlock form, then the read-only canvas.
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`/s/${token}`);
      await page.getByLabel('Password').fill('billing-only-1');
      await page.getByRole('button', { name: 'Open' }).click();
      await page.waitForURL(`**/s/${token}/p/${SEED.projectId}`);
      await expect(page.getByText('Shared view, read-only')).toBeVisible();
      await expect(page.getByText('order_items').first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Auto-layout' })).toHaveCount(0);
      await context.close();

      // Revocation propagates on the very next request (§7.12): no window.
      const revoked = await owner.api.delete(`/api/share-links/${link.id}`, { headers: write(owner) });
      expect(revoked.status()).toBe(204);
      expect((await visitor.get(`/api/projects/${SEED.projectId}/ir`)).status()).toBe(404);
      expect((await visitor.get(`/api/s/${token}`)).status()).toBe(404);
    } finally {
      await owner.api.delete(`/api/share-links/${link.id}`, { headers: write(owner) });
    }
  });
});
