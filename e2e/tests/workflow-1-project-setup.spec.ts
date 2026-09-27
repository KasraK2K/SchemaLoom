import { expect, test } from '@playwright/test';
import { API_URL, signIn, write, type Session } from '../fixtures/api';
import { fetchIr } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * SPEC §8 workflow #1 — sign up, create an org, create a PostgreSQL project, import SQL,
 * auto-layout, group tables into Areas.
 *
 * Phase 1 ships both ends of that chain and not the middle: the api exposes `auth`,
 * `engines`, `projects/:id/ir`, `projects/:id/schema/*` and `projects/:id/snapshots`, and
 * no controller for organizations, projects or DDL import. The steps that have a route
 * are tested; the three that do not are `test.fixme` naming the route they wait for, so
 * this file goes green by deleting a marker rather than by someone rediscovering the
 * workflow from the spec a year from now.
 */

const batchId = (tag: string): string => `bat_e2e_${tag}_${String(Date.now())}`;

interface MeResponse {
  readonly email: string;
}

test.describe('workflow 1 — from sign-up to a laid-out, grouped project', () => {
  test('a new account can be created and signs in', async ({ request }) => {
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

  test.fixme('creates an organization', () => {
    // Needs POST /api/organizations — not in Phase 1's route table.
  });

  test.fixme('creates a PostgreSQL project in that organization', () => {
    // Needs POST /api/projects. The engine list it picks from IS live: GET /api/engines.
  });

  test.fixme('imports a SQL file and gets entities back', () => {
    // Needs POST /api/projects/:id/import. The importer itself is finished and unit
    // tested in packages/engines/postgresql; only the route is missing.
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
