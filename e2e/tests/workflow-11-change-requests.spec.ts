import { expect, test } from '@playwright/test';
import { signIn, write, type Session } from '../fixtures/api';
import { entityNames, fetchIr, type Ir } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Phase 10 — change requests (`docs/phase10/DESIGN.md`), on a project of its own so a
 * merge here never moves the seed project other workflows assert on.
 *
 * The owner proposes, Adam (an editor with restricted access, so a complete view) reviews,
 * and the analyst, who cannot see the salary column, is kept out of the request entirely.
 */
test.describe.configure({ mode: 'serial' });

test.describe('workflow 11 — propose, review, merge', () => {
  let olivia: Session;
  let projectId = '';
  let requestId = '';
  let draftId = '';

  const ops = (session: Session, project: string, body: object[]) =>
    session.api.post(`/api/projects/${project}/schema/ops`, {
      headers: write(session),
      data: { batchId: `bat_e2e_cr_${String(Date.now())}`, projectId: project, ops: body },
    });

  const entityByName = (ir: Ir, name: string) =>
    Object.values(ir.objects.entity).find((e) => e.name === name);

  test.beforeAll(async () => {
    olivia = await signIn(SEED_EMAILS.owner);
    const created = await olivia.api.post('/api/projects', {
      headers: write(olivia),
      data: {
        organizationId: SEED.orgId,
        name: `Change requests ${String(Date.now())}`,
        engineId: 'postgresql',
        engineVersion: '16',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    projectId = ((await created.json()) as { id: string }).id;

    const imported = await olivia.api.post(`/api/projects/${projectId}/import`, {
      headers: write(olivia),
      data: {
        source:
          'CREATE TABLE customers (id uuid PRIMARY KEY, name text NOT NULL);\n' +
          'CREATE TABLE orders (id uuid PRIMARY KEY, customer_id uuid REFERENCES customers (id));',
      },
    });
    expect(imported.status(), await imported.text()).toBe(201);

    for (const [userId, canViewRestricted] of [
      [SEED.users.admin.id, true],
      [SEED.users.member.id, false],
    ] as const) {
      const grant = await olivia.api.post(`/api/projects/${projectId}/grants`, {
        headers: write(olivia),
        data: {
          principalKind: 'user',
          principalId: userId,
          resourceType: 'project',
          resourceId: projectId,
          roleKey: 'editor',
          canUseAi: false,
          canViewRestricted,
        },
      });
      expect(grant.status(), await grant.text()).toBe(201);
    }
    // A restricted column, so "complete view" separates Adam from Alex.
    const ir = await fetchIr(olivia, projectId);
    const name = Object.values(ir.objects.field).find((f) => f.name === 'name');
    const restricted = await ops(olivia, projectId, [
      {
        op: 'update',
        type: 'field',
        id: name?.id,
        expectedVersion: name?.version ?? 0,
        patch: { isRestricted: true },
      },
    ]);
    expect(restricted.status(), await restricted.text()).toBe(201);
  });

  test('someone without a complete view cannot propose, and sees no requests', async () => {
    const alex = await signIn(SEED_EMAILS.analyst);
    const proposed = await alex.api.post(`/api/projects/${projectId}/change-requests`, {
      headers: write(alex),
      data: { title: 'Nope' },
    });
    expect(proposed.status(), await proposed.text()).toBe(403);
    const list = await alex.api.get(`/api/projects/${projectId}/change-requests`);
    expect(await list.json()).toEqual([]);
  });

  test('the owner proposes; the draft is a hidden copy', async () => {
    const created = await olivia.api.post(`/api/projects/${projectId}/change-requests`, {
      headers: write(olivia),
      data: { title: 'Add invoices', reviewerIds: [SEED.users.admin.id] },
    });
    expect(created.status(), await created.text()).toBe(201);
    const body = (await created.json()) as { id: string; draftProjectId: string; status: string };
    expect(body.status).toBe('open');
    requestId = body.id;
    draftId = body.draftProjectId;

    const [main, draft] = await Promise.all([fetchIr(olivia, projectId), fetchIr(olivia, draftId)]);
    expect(entityNames(draft)).toEqual(entityNames(main));
    // Copies, not the same rows: ids are global primary keys.
    expect(Object.keys(draft.objects.entity)).not.toEqual(Object.keys(main.objects.entity));

    const listed = await olivia.api.get(`/api/organizations/${SEED.orgSlug}/projects`);
    const ids = ((await listed.json()) as { id: string }[]).map((p) => p.id);
    expect(ids).toContain(projectId);
    expect(ids).not.toContain(draftId);
  });

  test('the draft is 404 without a complete view, read-only for reviewers', async () => {
    const alex = await signIn(SEED_EMAILS.analyst);
    expect((await alex.api.get(`/api/projects/${draftId}/ir`)).status()).toBe(404);
    expect((await alex.api.get(`/api/change-requests/${requestId}`)).status()).toBe(404);

    const adam = await signIn(SEED_EMAILS.admin);
    const draft = await fetchIr(adam, draftId);
    const orders = entityByName(draft, 'orders');
    const edit = await ops(adam, draftId, [
      {
        op: 'update',
        type: 'entity',
        id: orders?.id,
        expectedVersion: orders?.version ?? 0,
        patch: { name: 'purchases' },
      },
    ]);
    expect(edit.status(), await edit.text()).toBe(403);
  });

  test('the author edits the draft and the request shows the diff in main ids', async () => {
    const draft = await fetchIr(olivia, draftId);
    const orders = entityByName(draft, 'orders');
    const edit = await ops(olivia, draftId, [
      {
        op: 'update',
        type: 'entity',
        id: orders?.id,
        expectedVersion: orders?.version ?? 0,
        patch: { name: 'purchases' },
      },
    ]);
    expect(edit.status(), await edit.text()).toBe(201);

    const main = await fetchIr(olivia, projectId);
    const detail = await olivia.api.get(`/api/change-requests/${requestId}`);
    expect(detail.status(), await detail.text()).toBe(200);
    const { changes } = (await detail.json()) as {
      changes: { entries: { change: string; objectType: string; id: string }[] };
    };
    expect(changes.entries).toEqual([
      expect.objectContaining({
        change: 'changed',
        objectType: 'entity',
        id: entityByName(main, 'orders')?.id,
      }),
    ]);
  });
});
