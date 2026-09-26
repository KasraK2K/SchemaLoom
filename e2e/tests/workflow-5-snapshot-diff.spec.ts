import { expect, test } from '@playwright/test';
import { signIn, write, type Session } from '../fixtures/api';
import { fetchIr } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * SPEC §8 workflow #5 — an editor changes the schema, saves a snapshot, views the diff,
 * exports a migration script.
 *
 * The first three are live routes. Export needs `POST /api/projects/:id/export`, which
 * Phase 1 does not ship (the exporter itself is finished and unit tested in
 * `packages/engines/postgresql`), so it is `test.fixme`.
 */

interface SnapshotSummary {
  readonly id: string;
  readonly name: string;
}

const uniq = (tag: string): string => `${tag}_${String(Date.now())}`;

async function snapshot(session: Session, name: string): Promise<SnapshotSummary> {
  const response = await session.api.post(`/api/projects/${SEED.projectId}/snapshots`, {
    headers: write(session),
    data: { name },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as SnapshotSummary;
}

test.describe('workflow 5 — change, snapshot, diff, export', () => {
  test('an editor changes the schema, snapshots it, and reads the diff back', async () => {
    const owner = await signIn(SEED_EMAILS.owner);

    const before = await snapshot(owner, uniq('before'));

    const ir = await fetchIr(owner, SEED.projectId);
    const orders = ir.objects.entity[SEED.entities.orders];
    expect(orders).toBeDefined();

    const changed = await owner.api.post(`/api/projects/${SEED.projectId}/schema/ops`, {
      headers: write(owner),
      data: {
        batchId: uniq('bat_e2e_w5'),
        projectId: SEED.projectId,
        ops: [
          {
            op: 'create',
            type: 'field',
            object: {
              id: uniq('fld_e2e_w5').slice(0, 40),
              name: 'cancelled_at',
              engineProps: {},
              entityId: SEED.entities.orders,
              parentFieldId: null,
              type: { name: 'timestamptz' },
              isNullable: true,
              isRestricted: false,
              isPii: false,
              isDeprecated: false,
            },
          },
        ],
        label: 'Add cancelled_at',
      },
    });
    expect(changed.status(), await changed.text()).toBe(201);

    const after = await snapshot(owner, uniq('after'));

    const listed = await owner.api.get(`/api/projects/${SEED.projectId}/snapshots`);
    expect(listed.status()).toBe(200);
    expect(((await listed.json()) as SnapshotSummary[]).map((s) => s.id)).toContain(after.id);

    const diff = await owner.api.get(
      `/api/projects/${SEED.projectId}/snapshots/${before.id}/diff/${after.id}`,
    );
    expect(diff.status(), await diff.text()).toBe(200);
    expect(await diff.text()).toContain('cancelled_at');
  });

  test('a read-only subject cannot snapshot, and cannot read history', async () => {
    const alex = await signIn(SEED_EMAILS.analyst);

    const created = await alex.api.post(`/api/projects/${SEED.projectId}/snapshots`, {
      headers: write(alex),
      data: { name: 'nope' },
    });
    expect(created.status()).toBe(403);

    // Viewer carries neither `schema:edit` nor `history:view`, so the listing is refused
    // too — snapshots are an edit-history surface, not a read surface.
    const listed = await alex.api.get(`/api/projects/${SEED.projectId}/snapshots`);
    expect(listed.status()).toBe(403);
  });

  test.fixme('exports a migration script from the diff', () => {
    // Needs POST /api/projects/:id/export. When it lands it must be asserted through a
    // REDACTED model (L18): the analyst's export of `employees` must not contain
    // `salary`, and an entity whose index was blanked must not silently emit DDL for a
    // table with no primary key (doc 04 §10.2's closing rule, `propsRedacted`).
  });
});
