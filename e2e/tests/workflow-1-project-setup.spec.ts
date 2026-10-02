import { expect, test, type APIRequestContext } from '@playwright/test';
import { API_URL, signIn, write, type Session } from '../fixtures/api';
import { fetchIr } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * SPEC §8 workflow #1 — sign up, create an org, create a PostgreSQL project, import SQL,
 * auto-layout, group tables into Areas.
 *
 * The first half runs through the real UI with a fresh account and org, so it never
 * touches the shared seed; the layout and area steps use the seeded project.
 */

const batchId = (tag: string): string => `bat_e2e_${tag}_${String(Date.now())}`;

/**
 * Roadmap 16: the first two tests sign up strangers, which needs SIGNUP_MODE=open (the e2e
 * api sets it; a reused dev server may not). Workflow 13 covers the invite-only path.
 */
async function skipUnlessSignupOpen(request: APIRequestContext): Promise<void> {
  const policy = await request.get(`${API_URL}/api/auth/signup-policy`);
  const { open } = (await policy.json()) as { open: boolean };
  test.skip(!open, 'sign-up is closed on this api (SIGNUP_MODE=invite)');
}

interface MeResponse {
  readonly email: string;
}

test.describe('workflow 1 — from sign-up to a laid-out, grouped project', () => {
  test('a new account can be created and signs in', async ({ request }) => {
    await skipUnlessSignupOpen(request);
    const email = `signup-${String(Date.now())}@acme.test`;
    const created = await request.post(`${API_URL}/api/auth/register`, {
      data: { email, password: 'SchemaLoom!demo1', name: 'New Signup' },
    });
    expect(created.status(), await created.text()).toBe(201);

    const session = await signIn(email);
    const me = await session.api.get('/api/auth/me');
    expect(me.status()).toBe(200);
    expect(((await me.json()) as MeResponse).email).toBe(email);
  });

  test('signs up, creates an org, imports SQL and lands on a laid-out canvas', async ({
    page,
    request,
  }) => {
    await skipUnlessSignupOpen(request);
    test.setTimeout(120_000);
    // A click that lands before React hydrates does nothing; retry until the form opens.
    const open = async (button: string, field: string) => {
      await expect(async () => {
        await page.getByRole('button', { name: button, exact: true }).click();
        await expect(page.getByLabel(field, { exact: true })).toBeVisible({ timeout: 1_000 });
      }).toPass({ timeout: 30_000 });
    };
    const stamp = String(Date.now());
    await page.goto('/signup');
    await page.getByLabel('Name', { exact: true }).fill('Import Tester');
    await page.getByLabel('Email').fill(`import-${stamp}@acme.test`);
    await page.getByLabel('Password').fill('SchemaLoom!demo1');
    await page.getByRole('button', { name: 'Create account' }).click();

    await open('New organisation', 'Organisation name');
    await page.getByLabel('Organisation name').fill(`Import Co ${stamp}`);
    await page.getByRole('button', { name: 'Create organisation' }).click();

    await open('Import', 'Name');
    await page.getByLabel('Name', { exact: true }).fill('Shop');
    // Target version is a dropdown that defaults to the engine's default (16).
    await page
      .getByRole('textbox', { name: 'SQL' })
      .fill(
        'CREATE TABLE customers (id uuid PRIMARY KEY, name text NOT NULL);\n' +
          'CREATE TABLE orders (id uuid PRIMARY KEY, customer_id uuid REFERENCES customers (id));',
      );
    await page.getByRole('button', { name: 'Create and import' }).click();

    await expect(page).toHaveURL(/\/p\/[^/]+$/, { timeout: 60_000 });
    await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 30_000 });

    // Two tables imported at the origin must not stay stacked: the canvas lays them out and
    // saves the positions. Read them back from the API — once laid out, React Flow stops
    // rendering whichever card scrolled off-screen, so the DOM cannot answer this.
    // ELK is loaded on demand, so the first layout can take a while on a cold server.
    const projectId = page.url().split('/p/')[1] ?? '';
    const positions = async (): Promise<number> => {
      const ir = await page.request.get(`${API_URL}/api/projects/${projectId}/ir`);
      const { objects } = (await ir.json()) as {
        objects: { entity: Record<string, { position: { x: number; y: number } }> };
      };
      return new Set(
        Object.values(objects.entity).map((e) => `${String(e.position.x)},${String(e.position.y)}`),
      ).size;
    };
    await expect.poll(positions, { timeout: 30_000 }).toBe(2);

    // Re-importing into the same project merges: existing tables are kept, new ones added.
    const csrf = (await page.context().cookies()).find((c) => c.name === 'sl_csrf')?.value ?? '';
    const merged = await page.request.post(`${API_URL}/api/projects/${projectId}/import`, {
      headers: { 'x-csrf-token': csrf },
      data: {
        source:
          'CREATE TABLE customers (id uuid PRIMARY KEY, name text NOT NULL);\n' +
          'CREATE TABLE invoices (id uuid PRIMARY KEY);',
      },
    });
    expect(merged.status(), await merged.text()).toBe(201);
    expect(((await merged.json()) as { existing: string[] }).existing).toEqual(['customers']);
    const ir = await page.request.get(`${API_URL}/api/projects/${projectId}/ir`);
    const names = Object.values(
      ((await ir.json()) as { objects: { entity: Record<string, { name: string }> } }).objects
        .entity,
    ).map((e) => e.name);
    expect(names.sort()).toEqual(['customers', 'invoices', 'orders']);
  });

  test('auto-layout moves every card, and the new position is served back', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const before = await fetchIr(owner, SEED.projectId);
    const ids = Object.keys(before.objects.entity);
    expect(ids.length).toBeGreaterThan(0);

    // §8.11 — geometry is the one write with no version and no conflict check, because
    // auto-layout rewrites three hundred positions in one gesture.
    const response = await owner.api.post(`/api/projects/${SEED.projectId}/schema/geometry`, {
      headers: write(owner),
      data: {
        batchId: batchId('layout'),
        entities: ids.map((id, i) => ({ id, position: { x: i * 400, y: 1111 } })),
      },
    });
    expect(response.status(), await response.text()).toBe(201);

    const canvas = await owner.api.get(`/api/projects/${SEED.projectId}/ir/canvas`);
    expect(canvas.status()).toBe(200);
    expect(await canvas.text()).toContain('1111');
  });

  test('tables are grouped into a new Area', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const areaId = `are_e2e_group_00000001`;

    const created = await applyOps(owner, 'create-area', [
      {
        op: 'create',
        type: 'area',
        object: { id: areaId, name: 'Fulfilment', engineProps: {}, color: 'amber', ordinal: 9 },
      },
    ]);
    expect(created.status(), await created.text()).toBe(201);

    const ir = await fetchIr(owner, SEED.projectId);
    expect(ir.objects.area[areaId]?.name).toBe('Fulfilment');

    // `employees`, not a Billing table: it is in no area, so moving it changes nobody's
    // grant. Regrouping `order_items` would pull it out of Dana's Billing share and break
    // workflows 2 and 4, which read the seed after this file runs.
    const entity = ir.objects.entity[SEED.entities.employees];
    expect(entity, 'employees must be visible to the org owner').toBeDefined();

    const moved = await applyOps(owner, 'regroup', [
      {
        op: 'update',
        type: 'entity',
        id: SEED.entities.employees,
        // C7 — echo the version the server just served, never a guess.
        expectedVersion: entity?.version ?? 0,
        patch: { areaId },
      },
    ]);
    expect(moved.status(), await moved.text()).toBe(201);

    // Doc 05 §9.3: an area create and an `areaId` move both bump the project generation,
    // so the next read must not come from a stale cached skeleton.
    const after = await fetchIr(owner, SEED.projectId);
    expect(after.objects.entity[SEED.entities.employees]?.areaId).toBe(areaId);
  });
});

function applyOps(session: Session, tag: string, ops: readonly Record<string, unknown>[]) {
  return session.api.post(`/api/projects/${SEED.projectId}/schema/ops`, {
    headers: write(session),
    data: { batchId: batchId(tag), projectId: SEED.projectId, ops, label: 'e2e' },
  });
}
