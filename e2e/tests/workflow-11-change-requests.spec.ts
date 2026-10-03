import { expect, test } from '@playwright/test';
import { signIn, signedInPage, write, type Session } from '../fixtures/api';
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

  interface Detail {
    status: string;
    draftRevision: string;
    mergeBlockedBy: string | null;
    conflicts: { type: string; id: string; name: string; reason: string }[];
    reviews: { verdict: string; current: boolean }[];
  }
  const detail = async (session: Session): Promise<Detail> => {
    const response = await session.api.get(`/api/change-requests/${requestId}`);
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as Detail;
  };
  const review = (session: Session, verdict: string) =>
    session.api.post(`/api/change-requests/${requestId}/reviews`, {
      headers: write(session),
      data: { verdict },
    });
  const renameIn = async (session: Session, project: string, from: string, to: string) => {
    const ir = await fetchIr(session, project);
    const entity = entityByName(ir, from);
    const response = await ops(session, project, [
      {
        op: 'update',
        type: 'entity',
        id: entity?.id,
        expectedVersion: entity?.version ?? 0,
        patch: { name: to },
      },
    ]);
    expect(response.status(), await response.text()).toBe(201);
  };

  test('reviews: the author cannot approve, changes requested blocks, an edit makes reviews stale', async () => {
    const adam = await signIn(SEED_EMAILS.admin);
    expect((await detail(olivia)).mergeBlockedBy).toBe('needs_approval');

    const own = await review(olivia, 'approved');
    expect(own.status(), await own.text()).toBe(403);

    expect((await review(adam, 'changes_requested')).status()).toBe(201);
    expect((await detail(olivia)).mergeBlockedBy).toBe('changes_requested');

    await renameIn(olivia, draftId, 'purchases', 'purchase_orders');
    const stale = await detail(olivia);
    expect(stale.reviews.map((r) => r.current)).toEqual([false]);
    expect(stale.mergeBlockedBy).toBe('needs_approval');

    expect((await review(adam, 'approved')).status()).toBe(201);
    expect((await detail(adam)).mergeBlockedBy).toBeNull();
  });

  test('the migration SQL is the rename', async () => {
    const response = await olivia.api.get(`/api/change-requests/${requestId}/migration`);
    expect(response.status(), await response.text()).toBe(200);
    const { script } = (await response.json()) as { script: string };
    expect(script).toMatch(/RENAME TO "?purchase_orders"?/);
  });

  test('a change to the same table on both sides is a conflict until updated from main', async () => {
    await renameIn(olivia, projectId, 'customers', 'clients');
    await renameIn(olivia, draftId, 'customers', 'buyers');

    const conflicted = await detail(olivia);
    expect(conflicted.mergeBlockedBy).toBe('conflicts');
    expect(conflicted.conflicts).toEqual([
      expect.objectContaining({ type: 'entity', name: 'clients', reason: 'both_changed' }),
    ]);
    const refused = await olivia.api.post(`/api/change-requests/${requestId}/merge`, {
      headers: write(olivia),
      data: { expectedDraftRevision: conflicted.draftRevision },
    });
    expect(refused.status(), await refused.text()).toBe(409);

    const adam = await signIn(SEED_EMAILS.admin);
    const notAuthor = await adam.api.post(`/api/change-requests/${requestId}/update-from-main`, {
      headers: write(adam),
    });
    expect(notAuthor.status()).toBe(403);

    const updated = await olivia.api.post(`/api/change-requests/${requestId}/update-from-main`, {
      headers: write(olivia),
    });
    expect(updated.status(), await updated.text()).toBe(200);
    const { reset } = (await updated.json()) as { reset: { name: string }[] };
    expect(reset.map((r) => r.name)).toEqual(['buyers']);
    // Main won on the conflict; the draft's other change survived.
    expect(entityNames(await fetchIr(olivia, draftId))).toEqual(['clients', 'purchase_orders']);
    const after = await detail(olivia);
    expect(after.conflicts).toEqual([]);
    expect(after.mergeBlockedBy).toBe('needs_approval');
  });

  test('an approved request merges once, as the merger, and the draft goes read-only', async () => {
    const adam = await signIn(SEED_EMAILS.admin);
    expect((await review(adam, 'approved')).status()).toBe(201);
    const ready = await detail(adam);
    expect(ready.mergeBlockedBy).toBeNull();

    const stale = await adam.api.post(`/api/change-requests/${requestId}/merge`, {
      headers: write(adam),
      data: { expectedDraftRevision: '0' },
    });
    expect(stale.status()).toBe(409);

    const merged = await adam.api.post(`/api/change-requests/${requestId}/merge`, {
      headers: write(adam),
      data: { expectedDraftRevision: ready.draftRevision },
    });
    expect(merged.status(), await merged.text()).toBe(200);
    expect(((await merged.json()) as { status: string }).status).toBe('merged');

    expect(entityNames(await fetchIr(olivia, projectId))).toEqual(['clients', 'purchase_orders']);
    const snapshots = await olivia.api.get(`/api/projects/${projectId}/snapshots`);
    const names = ((await snapshots.json()) as { name: string }[]).map((s) => s.name);
    expect(names).toContain('Before merging "Add invoices"');

    const again = await adam.api.post(`/api/change-requests/${requestId}/merge`, {
      headers: write(adam),
      data: { expectedDraftRevision: ready.draftRevision },
    });
    expect(again.status()).toBe(409);

    const draft = await fetchIr(olivia, draftId);
    const orders = entityByName(draft, 'purchase_orders');
    const edit = await ops(olivia, draftId, [
      {
        op: 'update',
        type: 'entity',
        id: orders?.id,
        expectedVersion: orders?.version ?? 0,
        patch: { name: 'late_edit' },
      },
    ]);
    expect(edit.status()).toBe(403);
  });

  test('the requested reviewer, the author and the analyst get what each may see', async () => {
    const types = async (email: string) => {
      const session = await signIn(email);
      const response = await session.api.get('/api/notifications');
      const { notifications } = (await response.json()) as {
        notifications: { type: string; title: string; url: string | null }[];
      };
      return notifications.filter((n) => n.type.startsWith('change_request.'));
    };
    const adam = await types(SEED_EMAILS.admin);
    expect(adam.map((n) => n.type)).toContain('change_request.review_requested');
    expect(adam.find((n) => n.type === 'change_request.merged')).toBeUndefined(); // he merged

    const olivia = await types(SEED_EMAILS.owner);
    expect(olivia.map((n) => n.type)).toEqual(
      expect.arrayContaining(['change_request.reviewed', 'change_request.merged']),
    );
    expect(olivia[0]?.url).toBe(`/${SEED.orgSlug}/p/${projectId}/changes/${requestId}`);
    // L7: free text that can name tables never reaches a stored title.
    expect(olivia.some((n) => n.title.includes('Add invoices'))).toBe(false);

    expect(await types(SEED_EMAILS.analyst)).toEqual([]);
  });

  test('delete: a merged or reviewed request stays; an unreviewed one goes with its draft', async () => {
    const del = (session: Session, id: string) =>
      session.api.delete(`/api/change-requests/${id}`, { headers: write(session) });
    const propose = async (title: string) => {
      const created = await olivia.api.post(`/api/projects/${projectId}/change-requests`, {
        headers: write(olivia),
        data: { title },
      });
      expect(created.status(), await created.text()).toBe(201);
      return (await created.json()) as { id: string; draftProjectId: string };
    };

    const merged = await del(olivia, requestId);
    expect(merged.status()).toBe(409);
    expect(((await merged.json()) as { error: { code: string } }).error.code).toBe(
      'change_request_merged',
    );

    const reviewed = await propose('Reviewed');
    const adam = await signIn(SEED_EMAILS.admin);
    const verdict = await adam.api.post(`/api/change-requests/${reviewed.id}/reviews`, {
      headers: write(adam),
      data: { verdict: 'changes_requested' },
    });
    expect(verdict.status(), await verdict.text()).toBe(201);
    expect((await del(olivia, reviewed.id)).status()).toBe(409);

    // Someone without a complete view gets the same 404 as a wrong id.
    const unreviewed = await propose('Throwaway');
    const alex = await signIn(SEED_EMAILS.analyst);
    expect((await del(alex, unreviewed.id)).status()).toBe(404);

    const gone = await del(olivia, unreviewed.id);
    expect(gone.status(), await gone.text()).toBe(204);
    expect((await olivia.api.get(`/api/change-requests/${unreviewed.id}`)).status()).toBe(404);
    expect((await olivia.api.get(`/api/projects/${unreviewed.draftProjectId}/ir`)).status()).toBe(
      404,
    );
    // Closed, not deleted, so the reviewed one doesn't clutter the browser test's list.
    await olivia.api.post(`/api/change-requests/${reviewed.id}/close`, { headers: write(olivia) });
  });

  test('in the browser: propose, continue the draft, submit it with a title (Phase 10c)', async ({
    browser,
  }) => {
    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}/p/${projectId}`);
    // No dialog: the draft opens at once, and the name comes on submit.
    await page.getByRole('button', { name: 'Propose a change' }).click();
    const draftBanner = page.getByRole('status').filter({ hasText: 'Your draft' });
    await expect(draftBanner.getByRole('button', { name: 'Submit changes' })).toBeVisible({
      timeout: 30_000,
    });
    expect(page.url()).not.toContain(projectId);
    const draftUrl = page.url();
    await page.screenshot({ path: 'test-results/cr-unsubmitted-draft.png' });

    // Proposing again opens the same draft.
    await draftBanner.getByRole('link', { name: 'Back to project' }).click();
    await page.getByRole('button', { name: 'Continue your draft' }).click();
    await expect(draftBanner).toBeVisible({ timeout: 30_000 });
    expect(page.url()).toBe(draftUrl);

    await draftBanner.getByRole('button', { name: 'Submit changes' }).click();
    await page.getByLabel('Title').fill('Rename clients');
    await page.getByLabel('Description (optional)').fill('Clients are customers now.');
    await page.getByRole('button', { name: 'Submit for review' }).click();
    await expect(page.getByRole('heading', { name: 'Rename clients' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByText('Clients are customers now.')).toBeVisible();

    // The draft's banner is the submitted one now.
    await page.goto(draftUrl);
    const banner = page.getByRole('status').filter({ hasText: 'Draft for' });
    await expect(banner).toContainText('Rename clients', { timeout: 30_000 });
    await page.screenshot({ path: 'test-results/cr-draft-canvas.png' });

    await banner.getByRole('link', { name: 'View request' }).click();
    await expect(page.getByRole('heading', { name: 'Rename clients' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Merge into the project' })).toBeDisabled();
    await expect(page.getByText('The draft has no changes to merge yet.')).toBeVisible();
    await expect(page.getByRole('note')).toContainText('Nothing has changed in the draft yet.');
    await expect(
      page.getByRole('link', { name: 'Open the draft to make your changes' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Changes', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.screenshot({ path: 'test-results/cr-request-page.png', fullPage: true });

    await page.getByRole('link', { name: '← Change requests' }).click();
    await expect(page.getByRole('link', { name: /Rename clients/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Add invoices/ })).toBeVisible();

    // Delete, confirmed: back on the list, and the request is gone.
    await page.getByRole('link', { name: /Rename clients/ }).click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Delete the request and its draft' }).click();
    await expect(page.getByRole('link', { name: '← Change requests' })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Add invoices/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /Rename clients/ })).toHaveCount(0);
  });

  test('a protected project takes schema only from a merge (Phase 10b)', async ({ browser }) => {
    const adam = await signIn(SEED_EMAILS.admin);
    const protect = (enabled: boolean) =>
      olivia.api.patch(`/api/projects/${projectId}/require-change-requests`, {
        headers: write(olivia),
        data: { enabled },
      });
    const refused = async (response: { status(): number; json(): Promise<unknown> }) => {
      expect(response.status()).toBe(423);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'project_protected',
      );
    };

    // Only a sharing manager can switch it.
    const byAdam = await adam.api.patch(`/api/projects/${projectId}/require-change-requests`, {
      headers: write(adam),
      data: { enabled: true },
    });
    expect(byAdam.status()).toBe(403);
    const on = await protect(true);
    expect(on.status(), await on.text()).toBe(200);
    expect(((await on.json()) as { requireChangeRequests: boolean }).requireChangeRequests).toBe(
      true,
    );
    const shell = await olivia.api.get(`/api/projects/${projectId}`);
    expect(((await shell.json()) as { requireChangeRequests: boolean }).requireChangeRequests).toBe(
      true,
    );

    try {
      const main = await fetchIr(olivia, projectId);
      const target = Object.values(main.objects.entity)[0];
      expect(target).toBeDefined();
      const name = target?.name ?? '';

      // Direct edit, import and restore: refused, for the owner too (Q2).
      await refused(
        await ops(olivia, projectId, [
          {
            op: 'update',
            type: 'entity',
            id: target?.id,
            expectedVersion: target?.version ?? 0,
            patch: { name: 'direct_edit' },
          },
        ]),
      );
      await refused(
        await olivia.api.post(`/api/projects/${projectId}/import`, {
          headers: write(olivia),
          data: { source: 'CREATE TABLE sneaky (id int PRIMARY KEY);' },
        }),
      );
      // The oldest snapshot ("Before merging…") differs from live; restoring an identical
      // one writes nothing and so never reaches SchemaWriter.
      const listed = await olivia.api.get(`/api/projects/${projectId}/snapshots`);
      const snapshots = (await listed.json()) as { id: string; createdAt: string }[];
      const snapshotId = [...snapshots].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
        ?.id;
      expect(snapshotId).toBeDefined();
      await refused(
        await olivia.api.post(`/api/projects/${projectId}/snapshots/${snapshotId ?? ''}/restore`, {
          headers: write(olivia),
        }),
      );

      // Phase 10c §4: layout too, so moving a table is refused.
      const move = (project: string, x: number) =>
        olivia.api.post(`/api/projects/${project}/schema/geometry`, {
          headers: write(olivia),
          data: {
            batchId: `bat_e2e_geo_${String(Date.now())}_${String(x)}`,
            entities: [{ id: target?.id, position: { x, y: 40 } }],
          },
        });
      await refused(await move(projectId, 40));

      // The canvas says so, and offers no edits at all, auto-layout included.
      const page = await signedInPage(browser, SEED_EMAILS.owner);
      await page.goto(`/${SEED.orgSlug}/p/${projectId}`);
      await expect(page.getByRole('status').filter({ hasText: 'Protected' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Propose a change' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Auto-layout' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Import SQL' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Propose a change' })).toBeVisible();
      await page.screenshot({ path: 'test-results/protected-canvas.png' });
      await page.getByRole('button', { name: 'Project settings' }).click();
      await expect(page.getByLabel('Require change requests')).toBeChecked();
      await page.screenshot({ path: 'test-results/protected-settings.png' });
      await page.close();

      // The way in (Phase 10c): propose with no title, edit and move in the draft, submit.
      const created = await olivia.api.post(`/api/projects/${projectId}/change-requests`, {
        headers: write(olivia),
        data: {},
      });
      expect(created.status(), await created.text()).toBe(201);
      const request = (await created.json()) as {
        id: string;
        draftProjectId: string;
        status: string;
      };
      expect(request.status).toBe('draft');
      // Unsubmitted is private: another editor neither sees nor opens it.
      expect((await adam.api.get(`/api/change-requests/${request.id}`)).status()).toBe(404);
      expect((await adam.api.get(`/api/projects/${request.draftProjectId}/ir`)).status()).toBe(404);
      const adamsList = await adam.api.get(`/api/projects/${projectId}/change-requests`);
      expect(((await adamsList.json()) as { id: string }[]).map((r) => r.id)).not.toContain(
        request.id,
      );
      // Proposing again returns the same draft.
      const again = await olivia.api.post(`/api/projects/${projectId}/change-requests`, {
        headers: write(olivia),
        data: {},
      });
      expect(((await again.json()) as { id: string }).id).toBe(request.id);

      await renameIn(olivia, request.draftProjectId, name, `${name}_v2`);
      const draftTarget = Object.values(
        (await fetchIr(olivia, request.draftProjectId)).objects.entity,
      ).find((e) => e.name === `${name}_v2`);
      const movedInDraft = await olivia.api.post(
        `/api/projects/${request.draftProjectId}/schema/geometry`,
        {
          headers: write(olivia),
          data: {
            batchId: `bat_e2e_geo_draft_${String(Date.now())}`,
            entities: [{ id: draftTarget?.id, position: { x: 777, y: 333 } }],
          },
        },
      );
      expect(movedInDraft.status(), await movedInDraft.text()).toBeLessThan(300);
      const submitted = await olivia.api.post(`/api/change-requests/${request.id}/submit`, {
        headers: write(olivia),
        data: { title: 'Rename under protection' },
      });
      expect(submitted.status(), await submitted.text()).toBe(200);
      expect(((await submitted.json()) as { status: string }).status).toBe('open');
      expect((await adam.api.get(`/api/change-requests/${request.id}`)).status()).toBe(200);
      const approved = await adam.api.post(`/api/change-requests/${request.id}/reviews`, {
        headers: write(adam),
        data: { verdict: 'approved' },
      });
      expect(approved.status(), await approved.text()).toBe(201);
      const detail = (await (
        await olivia.api.get(`/api/change-requests/${request.id}`)
      ).json()) as { draftRevision: string };
      const merged = await olivia.api.post(`/api/change-requests/${request.id}/merge`, {
        headers: write(olivia),
        data: { expectedDraftRevision: detail.draftRevision },
      });
      expect(merged.status(), await merged.text()).toBeLessThan(300);
      const after = await fetchIr(olivia, projectId);
      expect(entityNames(after)).toContain(`${name}_v2`);
      // The merge carried the draft's move (Phase 10c §4).
      expect(after.objects.entity[target?.id ?? '']?.position).toEqual({ x: 777, y: 333 });
    } finally {
      expect((await protect(false)).status()).toBe(200);
    }

    // Off again: a direct edit works.
    const first = Object.values((await fetchIr(olivia, projectId)).objects.entity)[0];
    await renameIn(olivia, projectId, first?.name ?? '', 'after_unprotect');
  });
});
