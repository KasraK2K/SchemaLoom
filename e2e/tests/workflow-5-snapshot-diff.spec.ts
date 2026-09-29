import { expect, test } from '@playwright/test';
import { signIn, write, type Session } from '../fixtures/api';
import { fetchIr } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * SPEC §8 workflow #5 — an editor changes the schema, saves a snapshot, views the diff,
 * exports a migration script.
 *
 * All four are live routes: the migration script comes from the Phase 5 generator
 * (`…/snapshots/:id/migration/live`) and the export from `POST /api/projects/:id/exports`.
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

  test('generates a migration script from a snapshot to the live schema', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const base = await snapshot(owner, uniq('migration_base'));
    const column = uniq('shipped_at').toLowerCase();

    const changed = await owner.api.post(`/api/projects/${SEED.projectId}/schema/ops`, {
      headers: write(owner),
      data: {
        batchId: uniq('bat_e2e_w5m'),
        projectId: SEED.projectId,
        ops: [
          {
            op: 'create',
            type: 'field',
            object: {
              id: uniq('fld_e2e_w5m').slice(0, 40),
              name: column,
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
        label: 'Add a column for the migration test',
      },
    });
    expect(changed.status(), await changed.text()).toBe(201);

    const plan = await owner.api.get(
      `/api/projects/${SEED.projectId}/snapshots/${base.id}/migration/live`,
    );
    expect(plan.status(), await plan.text()).toBe(200);
    const { script } = (await plan.json()) as { script: string };
    expect(script).toMatch(/ALTER TABLE .*orders.* ADD COLUMN .*shipped_at/i);

    // A partial view would produce a script that silently omits objects: refused (R21′).
    const dana = await signIn(SEED_EMAILS.freelancer);
    const refused = await dana.api.get(
      `/api/projects/${SEED.projectId}/snapshots/${base.id}/migration/live`,
    );
    expect([403, 404]).toContain(refused.status());
  });

  test('a DDL export is rendered from the redacted model (L11)', async () => {
    // The analyst sees `employees` with `salary` masked; the export must not name it.
    const alex = await signIn(SEED_EMAILS.analyst);
    const created = await alex.api.post(`/api/projects/${SEED.projectId}/exports`, {
      headers: write(alex),
      data: { format: 'ddl' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = (await created.json()) as { id: string };

    let downloadUrl: string | undefined;
    await expect(async () => {
      const job = (await (await alex.api.get(`/api/exports/${id}`)).json()) as {
        status: string;
        downloadUrl?: string;
      };
      expect(job.status).toBe('done');
      downloadUrl = job.downloadUrl;
    }).toPass({ timeout: 30_000 });

    const file = await alex.api.get(downloadUrl ?? '');
    expect(file.status()).toBe(200);
    const ddl = await file.text();
    expect(ddl).toContain('employees');
    expect(ddl).not.toContain('salary');
    expect(ddl).toContain('Some objects are not included because of your access level.');
  });
});
