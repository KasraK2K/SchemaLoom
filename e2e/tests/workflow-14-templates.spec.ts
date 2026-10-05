import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { API_URL, signIn, signedInPage, write, type Session } from '../fixtures/api';
import { assertE2eDatabase, executeSql } from '../fixtures/database';
import { entityNames, fetchIr } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Roadmap 12 (`docs/phase12/DESIGN.md`) — start from a template on the projects page, and
 * load one (or describe one) from an empty project's canvas. A template opens with its areas
 * drawn as cards (12b, `docs/phase12/ORG-TEMPLATES.md` §1). Runs as the seeded owner, in a
 * new project each time, so the shared seed is never touched.
 */

test.describe('workflow 14 — templates and the first-run canvas', () => {
  test('creates a project from the e-commerce template', async ({ browser }) => {
    test.setTimeout(120_000);
    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}`);

    // A click that lands before React hydrates does nothing; retry until the form opens.
    await expect(async () => {
      await page.getByRole('button', { name: 'Choose', exact: true }).click();
      await expect(page.getByLabel('Template')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });

    await page.getByLabel('Template').selectOption('ecommerce');
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('E-commerce');
    await page.getByLabel('Name', { exact: true }).fill(`Shop ${String(Date.now())}`);
    await page.getByRole('button', { name: 'Create project' }).click();

    await expect(page).toHaveURL(/\/p\/[^/]+$/, { timeout: 60_000 });
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 30_000 });

    const projectId = page.url().split('/p/')[1] ?? '';
    const ir = (await (
      await page.request.get(`${API_URL}/api/projects/${projectId}/ir`)
    ).json()) as {
      objects: {
        entity: Record<string, { name: string; areaId: string | null }>;
        area: Record<string, { id: string; name: string }>;
      };
    };
    const names = Object.values(ir.objects.entity).map((e) => e.name);
    expect(names.sort()).toEqual([
      'addresses',
      'customers',
      'order_items',
      'orders',
      'payments',
      'products',
    ]);

    // 12b — it opens organised into the template's cards, each drawn around its tables.
    const areaOf = (table: string): string | undefined => {
      const id = Object.values(ir.objects.entity).find((e) => e.name === table)?.areaId;
      return Object.values(ir.objects.area).find((area) => area.id === id)?.name;
    };
    expect(['customers', 'products', 'orders', 'payments'].map(areaOf)).toEqual([
      'Customers',
      'Catalog',
      'Orders',
      'Orders',
    ]);
    const cards = page.getByTestId('area-card');
    await expect(cards).toHaveCount(3);
    for (const name of ['Customers', 'Catalog', 'Orders']) {
      await expect(cards.filter({ hasText: name })).toHaveCount(1);
    }

    // The first-open auto layout keeps each card clear of the tables outside it.
    // Off-screen nodes are never mounted, so each attempt fits the view first, and a lookup
    // that finds no node gives up after a second so the poll retries instead of hanging.
    const boxOf = async (id: string) => {
      const box = await page
        .locator(`.react-flow__node[data-id="${id}"]`)
        .boundingBox({ timeout: 1_000 });
      if (box === null) throw new Error(`node ${id} is not on screen`);
      return box;
    };
    const entities = Object.entries(ir.objects.entity);
    await expect
      .poll(async () => {
        await page.keyboard.press('f');
        for (const area of Object.values(ir.objects.area)) {
          const card = await boxOf(`area:${area.id}`);
          for (const [id, e] of entities.filter(([, e]) => e.areaId !== area.id)) {
            const t = await boxOf(id);
            const touches =
              t.x < card.x + card.width &&
              card.x < t.x + t.width &&
              t.y < card.y + card.height &&
              card.y < t.y + t.height;
            if (touches) return `${e.name} overlaps ${area.name}`;
          }
        }
        return 'clear';
      })
      .toBe('clear');

    // The template's COMMENT ON statements arrive as docs: 6 tables and 4 columns.
    const docs = await page.request.get(`${API_URL}/api/projects/${projectId}/docs`);
    const written = ((await docs.json()) as { docs: { targetType: string }[] }).docs.filter(
      (d) => d.targetType !== 'project',
    );
    expect(written).toHaveLength(10);
  });

  test('an empty project can load a template or describe a schema', async ({ browser }) => {
    test.setTimeout(120_000);
    const owner = await signIn(SEED_EMAILS.owner);
    const created = await owner.api.post('/api/projects', {
      headers: write(owner),
      data: {
        organizationId: SEED.orgId,
        name: `Empty ${String(Date.now())}`,
        engineId: 'postgresql',
        engineVersion: '16',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const projectId = ((await created.json()) as { id: string }).id;

    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}/p/${projectId}`);

    await expect(async () => {
      await page.getByRole('button', { name: 'Describe', exact: true }).click();
      await expect(page.getByLabel('Describe a schema')).toBeFocused({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });

    await page.getByLabel('Load a template').selectOption('blog');
    await expect(page.getByRole('textbox', { name: 'SQL' })).toHaveValue(/CREATE TABLE posts/);
  });

  test('COMMENT ON in imported SQL becomes docs, and a hand-written doc is kept', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const created = await owner.api.post('/api/projects', {
      headers: write(owner),
      data: {
        organizationId: SEED.orgId,
        name: `Comments ${String(Date.now())}`,
        engineId: 'postgresql',
        engineVersion: '16',
      },
    });
    const projectId = ((await created.json()) as { id: string }).id;
    const importSql = (source: string) =>
      owner.api.post(`/api/projects/${projectId}/import`, {
        headers: write(owner),
        data: { source },
      });
    const docs = async () =>
      (
        (await (await owner.api.get(`/api/projects/${projectId}/docs`)).json()) as {
          docs: { targetType: string; plainText: string }[];
        }
      ).docs
        .filter((d) => d.targetType !== 'project')
        .map((d) => d.plainText)
        .sort();

    const first = await importSql(
      'CREATE TABLE orders (id bigint PRIMARY KEY, total numeric);\n' +
        "COMMENT ON TABLE orders IS 'One row per order';\n" +
        "COMMENT ON COLUMN orders.total IS 'Gross, in cents';",
    );
    expect(first.status(), await first.text()).toBe(201);
    expect(((await first.json()) as { documented: number }).documented).toBe(2);
    expect(await docs()).toEqual(['Gross, in cents', 'One row per order']);

    // Re-importing a different comment does not replace the doc that exists.
    const again = await importSql(
      'CREATE TABLE orders (id bigint PRIMARY KEY, total numeric);\n' +
        "COMMENT ON TABLE orders IS 'Something else';",
    );
    expect(((await again.json()) as { documented: number }).documented).toBe(0);
    expect(await docs()).toEqual(['Gross, in cents', 'One row per order']);
  });
});

/**
 * Roadmap 12c (`docs/phase12/ORG-TEMPLATES.md` §2–§3) — save a project as an org template
 * and start another from it. Serial: one source project and one template, made here.
 */
test.describe('workflow 14 — org templates', () => {
  test.describe.configure({ mode: 'serial' });
  const tag = String(Date.now());
  const templateName = `House schema ${tag}`;
  let olivia: Session;
  let sourceId = '';
  let templateId = '';

  const createProject = (session: Session, name: string, extra: object = {}) =>
    session.api.post('/api/projects', {
      headers: write(session),
      data: {
        organizationId: SEED.orgId,
        name,
        engineId: 'postgresql',
        engineVersion: '16',
        ...extra,
      },
    });
  const ops = (projectId: string, body: object[]) =>
    olivia.api.post(`/api/projects/${projectId}/schema/ops`, {
      headers: write(olivia),
      data: { batchId: randomUUID(), projectId, ops: body },
    });
  const listTemplates = async (session: Session) =>
    (await (await session.api.get(`/api/organizations/${SEED.orgSlug}/templates`)).json()) as {
      id: string;
      name: string;
      usable: boolean;
    }[];
  const docTexts = async (projectId: string) =>
    (
      (await (await olivia.api.get(`/api/projects/${projectId}/docs`)).json()) as {
        docs: { targetType: string; plainText: string }[];
      }
    ).docs
      .filter((d) => d.targetType !== 'project')
      .map((d) => d.plainText)
      .sort();

  test.beforeAll(async () => {
    olivia = await signIn(SEED_EMAILS.owner);
    const created = await createProject(olivia, `House source ${tag}`);
    expect(created.status(), await created.text()).toBe(201);
    sourceId = ((await created.json()) as { id: string }).id;
    const imported = await olivia.api.post(`/api/projects/${sourceId}/import`, {
      headers: write(olivia),
      data: {
        source:
          'CREATE TABLE customers (id uuid PRIMARY KEY, email text NOT NULL);\n' +
          'CREATE TABLE orders (id uuid PRIMARY KEY, customer_id uuid REFERENCES customers (id), total numeric);\n' +
          "COMMENT ON TABLE orders IS 'One row per order';\n" +
          "COMMENT ON COLUMN orders.total IS 'Gross, in cents';",
      },
    });
    expect(imported.status(), await imported.text()).toBe(201);
    const ir = await fetchIr(olivia, sourceId);
    const orders = Object.values(ir.objects.entity).find((e) => e.name === 'orders');
    const areaId = randomUUID();
    const grouped = await ops(sourceId, [
      {
        op: 'create',
        type: 'area',
        object: { id: areaId, name: 'Sales', color: 'area-1', ordinal: 0, engineProps: {} },
      },
      {
        op: 'update',
        type: 'entity',
        id: orders?.id,
        expectedVersion: orders?.version ?? 0,
        patch: { areaId },
      },
    ]);
    expect(grouped.status(), await grouped.text()).toBe(201);
  });

  test('save from the project menu, then start a project from it with the same tables and cards', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}`);
    await expect(async () => {
      await page.getByRole('button', { name: `Actions for House source ${tag}` }).click();
      await expect(page.getByRole('menuitem', { name: 'Save as template…' })).toBeVisible({
        timeout: 1_000,
      });
    }).toPass({ timeout: 30_000 });
    await page.getByRole('menuitem', { name: 'Save as template…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('will see these 2 tables and their docs');
    await dialog.getByLabel('Name').fill(templateName);
    await dialog.getByRole('button', { name: 'Save template' }).click();
    await expect(dialog).toContainText('Saved.');
    await dialog.getByRole('button', { name: 'Done' }).click();

    templateId = (await listTemplates(olivia)).find((t) => t.name === templateName)?.id ?? '';
    expect(templateId).not.toBe('');

    await page.reload();
    await expect(async () => {
      await page.getByRole('button', { name: 'Choose', exact: true }).click();
      await expect(page.getByLabel('Template')).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 30_000 });
    await page.getByLabel('Template').selectOption(`org:${templateId}`);
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue(templateName);
    await page.getByLabel('Name', { exact: true }).fill(`From house ${tag}`);
    await page.getByRole('button', { name: 'Create project' }).click();

    await expect(page).toHaveURL(/\/p\/[^/]+$/, { timeout: 60_000 });
    const madeId = page.url().split('/p/')[1] ?? '';
    expect(entityNames(await fetchIr(olivia, madeId))).toEqual(['customers', 'orders']);
    await expect(page.getByTestId('area-card')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId('area-card')).toContainText('Sales');
  });

  test('someone who cannot see the whole project cannot save it (403)', async () => {
    // Alex manages the project but may not read restricted columns: a partial view.
    const ir = await fetchIr(olivia, sourceId);
    const email = Object.values(ir.objects.field).find((f) => f.name === 'email');
    const restricted = await ops(sourceId, [
      {
        op: 'update',
        type: 'field',
        id: email?.id,
        expectedVersion: email?.version ?? 0,
        patch: { isRestricted: true },
      },
    ]);
    expect(restricted.status(), await restricted.text()).toBe(201);
    const grant = await olivia.api.post(`/api/projects/${sourceId}/grants`, {
      headers: write(olivia),
      data: {
        principalKind: 'user',
        principalId: SEED.users.member.id,
        resourceType: 'project',
        resourceId: sourceId,
        roleKey: 'manager',
        canUseAi: false,
        canViewRestricted: false,
      },
    });
    expect(grant.status(), await grant.text()).toBe(201);

    const alex = await signIn(SEED_EMAILS.analyst);
    const saved = await alex.api.post(`/api/projects/${sourceId}/save-as-template`, {
      headers: write(alex),
      data: { name: 'Not mine to share' },
    });
    expect(saved.status(), await saved.text()).toBe(403);
    expect(await saved.text()).toContain('org_template_full_view_required');
  });

  test('a project made from it has fresh ids, the docs and areas, and no comments or grants', async () => {
    const source = await fetchIr(olivia, sourceId);
    const orders = Object.values(source.objects.entity).find((e) => e.name === 'orders');
    const comment = await olivia.api.post(`/api/projects/${sourceId}/comments`, {
      headers: write(olivia),
      data: {
        targetType: 'entity',
        targetId: orders?.id,
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Stays here' }] }],
        },
      },
    });
    expect(comment.status(), await comment.text()).toBe(201);
    // Replace, so the template holds the commented, shared, restricted project.
    const replaced = await olivia.api.post(`/api/projects/${sourceId}/save-as-template`, {
      headers: write(olivia),
      data: { name: templateName, replaceId: templateId },
    });
    expect(replaced.status(), await replaced.text()).toBe(201);
    expect((await listTemplates(olivia)).filter((t) => t.name === templateName)).toHaveLength(1);

    const made = await createProject(olivia, `Copy ${tag}`, { orgTemplateId: templateId });
    expect(made.status(), await made.text()).toBe(201);
    const madeId = ((await made.json()) as { id: string }).id;
    const copy = await fetchIr(olivia, madeId);

    expect(entityNames(copy)).toEqual(entityNames(source));
    for (const type of ['entity', 'field', 'area'] as const) {
      const ids = Object.keys(copy.objects[type]);
      expect(ids.filter((id) => id in source.objects[type])).toEqual([]);
    }
    const copiedOrders = Object.values(copy.objects.entity).find((e) => e.name === 'orders');
    expect(Object.values(copy.objects.area).map((a) => a.name)).toEqual(['Sales']);
    expect(copiedOrders?.areaId).toBe(Object.keys(copy.objects.area)[0]);
    expect(await docTexts(madeId)).toEqual(await docTexts(sourceId));

    const comments = await olivia.api.get(
      `/api/projects/${madeId}/comments?targetType=entity&targetId=${copiedOrders?.id ?? ''}`,
    );
    expect(comments.status()).toBe(200);
    expect(await comments.text()).not.toContain('Stays here');
    const access = (await (await olivia.api.get(`/api/projects/${madeId}/access`)).json()) as {
      entries: { principal: { id: string }; grants: { resourceType: string }[] }[];
    };
    const alex = access.entries.find((e) => e.principal.id === SEED.users.member.id);
    expect(alex?.grants.filter((g) => g.resourceType === 'project') ?? []).toEqual([]);
  });

  test('a guest cannot start a project from it', async () => {
    const dana = await signIn(SEED_EMAILS.freelancer);
    expect(await listTemplates(dana)).toEqual([]);
    const made = await createProject(dana, `Guest ${tag}`, { orgTemplateId: templateId });
    expect(made.status(), await made.text()).toBe(403);
  });

  test('deleting the source keeps the template; an older engine major is refused', async () => {
    const deleted = await olivia.api.delete(`/api/projects/${sourceId}`, {
      headers: write(olivia),
    });
    expect(deleted.status()).toBe(204);
    expect((await listTemplates(olivia)).find((t) => t.id === templateId)?.usable).toBe(true);

    executeSql(
      assertE2eDatabase(process.env.DATABASE_URL_E2E),
      `UPDATE org_templates SET engine_major = 0 WHERE id = '${templateId}';`,
    );
    expect((await listTemplates(olivia)).find((t) => t.id === templateId)?.usable).toBe(false);
    const made = await createProject(olivia, `Old ${tag}`, { orgTemplateId: templateId });
    expect(made.status(), await made.text()).toBe(422);

    const removed = await olivia.api.delete(
      `/api/organizations/${SEED.orgSlug}/templates/${templateId}`,
      { headers: write(olivia) },
    );
    expect(removed.status()).toBe(204);
  });
});
