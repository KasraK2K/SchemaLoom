import { expect, test } from '@playwright/test';
import { signIn } from '../fixtures/api';
import { fetchIr } from '../fixtures/ir';
import { SEED } from '../fixtures/seed-ids';

/**
 * SPEC §8 workflow #4 — a guest opens an invite link, sees only the shared tables, and
 * links to hidden tables render as restricted STUBS.
 *
 * The share-link session itself needs `POST /api/share-links` and the `sl_session`
 * cookie exchange, which Phase 1 does not ship (`SHARE_LINK_ROUTES` names the allow-list
 * a link will be confined to, and nothing populates it yet). The STUB behaviour — the
 * part of this workflow that is a security property rather than a feature — is fully
 * reachable through the org guest with an area-only grant, which is the same code path
 * in `VisibilityFilter` with a different subject, so it is tested for real here.
 */
test.describe('workflow 4 — hidden neighbours render as stubs, not as holes', () => {
  test('a link into a hidden table survives as a nameless stub', async () => {
    const dana = await signIn(SEED.users.freelancer);
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
    const dana = await signIn(SEED.users.freelancer);
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
    const dana = await signIn(SEED.users.freelancer);
    const ir = await fetchIr(dana, SEED.projectId);

    // `employees` is in no area and nothing visible links to it. A stub for it would be
    // an existence disclosure bought for nothing.
    expect(ir.objects.entity[SEED.entities.employees]).toBeUndefined();
  });

  test.fixme('a guest opens the invite link and gets the same view', () => {
    // Needs POST /api/share-links plus the sl_session exchange. When it lands, the
    // ceiling (R17) is the assertion: a share-link subject holds at most `schema:view`
    // at every resource, however generous the link's own grant is — so no comments, no
    // presence, and revoking the link mid-session 404s the very next request.
  });
});
