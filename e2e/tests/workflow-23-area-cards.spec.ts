import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signedInPage, signIn, write, type Session } from '../fixtures/api';
import { fetchIr, type Ir } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Roadmap 23 (`docs/phase23/AREA-CARDS.md`) — areas drawn as coloured cards behind their
 * tables: group a selection, rename and recolour, auto layout keeps every table inside its
 * card, a table dropped on a card joins it, "Remove from area" lets it go. Runs as the
 * seeded owner in a new project each time, so the shared seed is never touched.
 */

const SQL =
  'CREATE TABLE authors (id uuid PRIMARY KEY, name text);\n' +
  'CREATE TABLE books (id uuid PRIMARY KEY, title text, author_id uuid REFERENCES authors(id));\n' +
  'CREATE TABLE book_shelves (id uuid PRIMARY KEY, book_id uuid REFERENCES books(id), shelf text);\n' +
  'CREATE TABLE orders (id uuid PRIMARY KEY, total numeric);\n';

async function newProject(owner: Session): Promise<string> {
  const created = await owner.api.post('/api/projects', {
    headers: write(owner),
    data: {
      organizationId: SEED.orgId,
      name: `Cards ${String(Date.now())}${randomUUID().slice(0, 4)}`,
      engineId: 'postgresql',
      engineVersion: '16',
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const projectId = ((await created.json()) as { id: string }).id;
  const imported = await owner.api.post(`/api/projects/${projectId}/import`, {
    headers: write(owner),
    data: { source: SQL },
  });
  expect(imported.status(), await imported.text()).toBe(201);
  return projectId;
}

/** The import lands piled at the origin; the canvas lays it out once and saves that. */
const waitForPlacement = async (owner: Session, projectId: string): Promise<void> => {
  await expect
    .poll(async () => {
      const ir = await fetchIr(owner, projectId);
      return new Set(
        Object.values(ir.objects.entity).map(
          (e) => `${String(e.position.x)},${String(e.position.y)}`,
        ),
      ).size;
    })
    .toBeGreaterThan(1);
};

const idOf = (ir: Ir, name: string): string => {
  const entity = Object.values(ir.objects.entity).find((e) => e.name === name);
  if (entity === undefined) throw new Error(`no table ${name}`);
  return entity.id;
};

interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

const rectOf = async (page: Page, nodeId: string): Promise<Rect> => {
  const box = await page.locator(`.react-flow__node[data-id="${nodeId}"]`).boundingBox();
  if (box === null) throw new Error(`node ${nodeId} is not on screen`);
  return box;
};

const inside = (inner: Rect, outer: Rect): boolean =>
  inner.x >= outer.x - 1 &&
  inner.y >= outer.y - 1 &&
  inner.x + inner.width <= outer.x + outer.width + 1 &&
  inner.y + inner.height <= outer.y + outer.height + 1;

const touches = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Click the table's header, which is not a column row (a column click selects the column). */
const selectTables = async (page: Page, ids: readonly string[]): Promise<void> => {
  for (const [i, id] of ids.entries()) {
    await page
      .locator(`.react-flow__node[data-id="${id}"]`)
      .click({ position: { x: 24, y: 14 }, modifiers: i === 0 ? [] : ['Shift'] });
  }
};

/** Grab the table by its header and drop it with its CENTRE (what the canvas hit-tests) on the card's. */
const dragOnto = async (
  page: Page,
  tableId: string,
  target: Rect,
  whileOver?: () => Promise<void>,
): Promise<void> => {
  const from = await rectOf(page, tableId);
  const grab = { x: from.x + 24, y: from.y + 14 };
  const aim = {
    x: target.x + target.width / 2 + (grab.x - (from.x + from.width / 2)),
    y: target.y + target.height / 2 + (grab.y - (from.y + from.height / 2)),
  };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(aim.x, aim.y, { steps: 12 });
  await whileOver?.();
  await page.mouse.up();
};

test.describe('workflow 23 — area cards', () => {
  test('group, rename, recolour, auto layout, join, remove and ungroup', async ({ browser }) => {
    test.setTimeout(180_000);
    const owner = await signIn(SEED_EMAILS.owner);
    const projectId = await newProject(owner);
    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}/p/${projectId}`);
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 30_000 });
    await waitForPlacement(owner, projectId);
    // Tables outside the viewport are not mounted (culling); bring them all into view.
    await page.keyboard.press('f');
    let ir = await fetchIr(owner, projectId);
    const [authors, books, shelves, orders] = ['authors', 'books', 'book_shelves', 'orders'].map(
      (name) => idOf(ir, name),
    ) as [string, string, string, string];

    // ── group three tables (Ctrl+G); the name field takes focus ──────────────────────────
    await selectTables(page, [authors, books, shelves]);
    await page.keyboard.press('Control+g');
    const nameField = page.getByLabel('Area name');
    await expect(nameField).toBeFocused({ timeout: 15_000 });
    await expect(nameField).toHaveValue('Area 1');
    await nameField.fill('Library');
    await nameField.press('Enter');

    await expect
      .poll(async () => {
        ir = await fetchIr(owner, projectId);
        return Object.values(ir.objects.area).map((a) => a.name);
      })
      .toEqual(['Library']);
    const area = Object.values(ir.objects.area)[0];
    if (area === undefined) throw new Error('no area');
    for (const id of [authors, books, shelves]) {
      expect(ir.objects.entity[id]?.areaId).toBe(area.id);
    }
    expect(ir.objects.entity[orders]?.areaId).toBeNull();
    const card = page.getByTestId('area-card');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Library');

    // ── recolour from the label's menu ───────────────────────────────────────────────────
    await card.getByRole('button', { name: 'Library' }).click();
    await page
      .getByRole('group', { name: 'Colour' })
      .getByRole('button', { name: 'Colour 4' })
      .click();
    await expect
      .poll(async () => {
        const now = await fetchIr(owner, projectId);
        return Object.values(now.objects.area)[0]?.color;
      })
      .toBe('area-4');

    // ── auto layout: every member's box ends up inside the card's, the others outside ────
    const before = JSON.stringify(Object.values(ir.objects.entity).map((e) => [e.id, e.position]));
    await page.keyboard.press('Control+Shift+L');
    await expect
      .poll(async () => {
        const now = await fetchIr(owner, projectId);
        return JSON.stringify(Object.values(now.objects.entity).map((e) => [e.id, e.position]));
      })
      .not.toBe(before);
    await page.keyboard.press('f');
    const cardNode = `area:${area.id}`;
    await expect(page.locator(`.react-flow__node[data-id="${cardNode}"]`)).toBeVisible();
    await expect
      .poll(async () => {
        const outer = await rectOf(page, cardNode);
        const members = await Promise.all([authors, books, shelves].map((id) => rectOf(page, id)));
        const other = await rectOf(page, orders);
        return members.every((m) => inside(m, outer)) && !touches(outer, other);
      })
      .toBe(true);

    // ── dragging the card's empty part moves it with every table in it ───────────────────
    const members = [authors, books, shelves];
    const positions = async (): Promise<Map<string, { x: number; y: number }>> => {
      const now = await fetchIr(owner, projectId);
      return new Map(members.map((id) => [id, now.objects.entity[id]?.position ?? { x: 0, y: 0 }]));
    };
    const start = await positions();
    const cardBox = await rectOf(page, cardNode);
    await page.mouse.move(cardBox.x + cardBox.width - 5, cardBox.y + cardBox.height - 5);
    await page.mouse.down();
    await page.mouse.move(cardBox.x + cardBox.width + 45, cardBox.y + cardBox.height + 45, {
      steps: 10,
    });
    await page.mouse.up();
    await expect
      .poll(async () => {
        const moved = await positions();
        const deltas = members.map((id) => {
          const a = start.get(id);
          const b = moved.get(id);
          return `${String((b?.x ?? 0) - (a?.x ?? 0))},${String((b?.y ?? 0) - (a?.y ?? 0))}`;
        });
        return new Set(deltas).size === 1 && deltas[0] !== '0,0';
      })
      .toBe(true);

    // ── drag a table onto the card: it highlights while over it, and joins on drop ───────
    await dragOnto(page, orders, await rectOf(page, cardNode), async () => {
      await expect(card).toHaveAttribute('data-highlighted', 'true');
    });
    await expect
      .poll(async () => (await fetchIr(owner, projectId)).objects.entity[orders]?.areaId)
      .toBe(area.id);
    await expect(card).toHaveAttribute('data-highlighted', 'false');

    // ── remove it again from its menu ────────────────────────────────────────────────────
    await page
      .locator(`.react-flow__node[data-id="${orders}"]`)
      .click({ button: 'right', position: { x: 24, y: 14 } });
    await page.getByRole('button', { name: 'Remove from area' }).click();
    await expect
      .poll(async () => (await fetchIr(owner, projectId)).objects.entity[orders]?.areaId)
      .toBeNull();

    // ── ungroup keeps the tables and deletes the area ────────────────────────────────────
    await card.getByRole('button', { name: 'Library' }).click();
    await page.getByRole('menuitem', { name: 'Ungroup' }).click();
    await expect
      .poll(async () => Object.keys((await fetchIr(owner, projectId)).objects.area).length)
      .toBe(0);
    ir = await fetchIr(owner, projectId);
    expect(Object.keys(ir.objects.entity)).toHaveLength(4);
    expect(Object.values(ir.objects.entity).every((e) => e.areaId === null)).toBe(true);
    await expect(card).toHaveCount(0);
  });

  test('says who will see a table before it joins a shared area', async ({ browser }) => {
    test.setTimeout(180_000);
    const owner = await signIn(SEED_EMAILS.owner);
    const projectId = await newProject(owner);
    let ir = await fetchIr(owner, projectId);
    const [authors, books, orders] = ['authors', 'books', 'orders'].map((name) =>
      idOf(ir, name),
    ) as [string, string, string];

    // A card around authors and books, shared with the analyst.
    const areaId = randomUUID();
    const ops = await owner.api.post(`/api/projects/${projectId}/schema/ops`, {
      headers: write(owner),
      data: {
        batchId: randomUUID(),
        projectId,
        ops: [
          {
            op: 'create',
            type: 'area',
            object: { id: areaId, name: 'Catalog', engineProps: {}, color: 'area-2', ordinal: 0 },
          },
          ...[authors, books].map((id) => ({
            op: 'update',
            type: 'entity',
            id,
            expectedVersion: ir.objects.entity[id]?.version ?? 0,
            patch: { areaId },
          })),
        ],
      },
    });
    expect(ops.status(), await ops.text()).toBe(201);
    const grant = await owner.api.post(`/api/projects/${projectId}/grants`, {
      headers: write(owner),
      data: {
        principalKind: 'user',
        principalId: SEED.users.member.id,
        resourceType: 'area',
        resourceId: areaId,
        roleKey: 'viewer',
        canUseAi: false,
        canViewRestricted: false,
      },
    });
    expect(grant.status(), await grant.text()).toBe(201);

    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}/p/${projectId}`);
    await expect(page.getByTestId('area-card')).toBeVisible({ timeout: 30_000 });
    await waitForPlacement(owner, projectId);
    await page.keyboard.press('f');
    const card = `area:${areaId}`;

    // Cancel: nothing is written.
    await dragOnto(page, orders, await rectOf(page, card));
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('Catalog is shared with 1 person');
    await expect(dialog).toContainText('They will see `orders` too');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    ir = await fetchIr(owner, projectId);
    expect(ir.objects.entity[orders]?.areaId).toBeNull();

    // Continue: it joins.
    await dragOnto(page, orders, await rectOf(page, card));
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect
      .poll(async () => (await fetchIr(owner, projectId)).objects.entity[orders]?.areaId)
      .toBe(areaId);
  });
});
