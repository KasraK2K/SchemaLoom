import { expect, test } from '@playwright/test';
import { signIn, write, type Session } from '../fixtures/api';
import { fetchIr } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Doc 05 §7.7 and §7.12-§7.14 against the real API: the routes behind
 * `apps/web/src/features/sharing`.
 *
 * Runs LAST (the `workflow-6` name) and undoes every grant it writes, because workflows
 * 2 and 4 assert on exactly the seed's two grants and would see these otherwise.
 */

const P = SEED.projectId;

interface AccessList {
  canManage: boolean;
  resources: { type: string; id: string; name: string; parentId: string | null }[];
  roles: { key: string }[];
  entries: {
    principal: { kind: string; id: string };
    grants: { id: string; resourceId: string; roleKey: string }[];
  }[];
}

const accessOf = async (session: Session): Promise<AccessList> => {
  const response = await session.api.get(`/api/projects/${P}/access?explain=1`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as AccessList;
};

const grant = (session: Session, body: Record<string, unknown>) =>
  session.api.post(`/api/projects/${P}/grants`, {
    headers: write(session),
    data: { canUseAi: false, canViewRestricted: false, ...body },
  });

const errorCode = async (response: { json(): Promise<unknown> }): Promise<string> =>
  ((await response.json()) as { error: { code: string } }).error.code;

test.describe('sharing API — who has access, grants, links and requests', () => {
  test('the owner sees the tree, the five built-in roles and Dana’s Billing grant', async () => {
    const access = await accessOf(await signIn(SEED_EMAILS.owner));
    expect(access.canManage).toBe(true);
    expect(access.roles.map((r) => r.key)).toEqual([
      'viewer',
      'commenter',
      'documenter',
      'editor',
      'manager',
    ]);
    expect(access.resources.find((r) => r.id === SEED.areas.billing)?.parentId).toBe(P);

    const dana = access.entries.find((e) => e.principal.id === SEED.users.guest.id);
    expect(dana?.grants.map((g) => [g.resourceId, g.roleKey])).toEqual([
      [SEED.areas.billing, 'editor'],
    ]);
  });

  test('a guest is refused the dialog outright; a viewer sees no one', async () => {
    const dana = await signIn(SEED_EMAILS.freelancer);
    const refused = await dana.api.get(`/api/projects/${P}/access`);
    expect(refused.status()).toBe(403);

    const analyst = await accessOf(await signIn(SEED_EMAILS.analyst));
    expect(analyst.canManage).toBe(false);
    expect(analyst.entries).toEqual([]);
  });

  test('R4: a non-manager cannot grant, and a manager cannot grant what they lack', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const analyst = await signIn(SEED_EMAILS.analyst);

    const denied = await grant(analyst, {
      principalKind: 'user',
      principalId: SEED.users.guest.id,
      resourceType: 'area',
      resourceId: SEED.areas.billing,
      roleKey: 'viewer',
    });
    expect(denied.status()).toBe(403);
    expect(await errorCode(denied)).toBe('sharing_not_permitted');

    // Make the analyst Billing's manager, then have them try to hand out restricted access.
    const made = await grant(owner, {
      principalKind: 'user',
      principalId: SEED.users.member.id,
      resourceType: 'area',
      resourceId: SEED.areas.billing,
      roleKey: 'manager',
    });
    expect(made.status(), await made.text()).toBe(201);
    const { id: managerGrant } = (await made.json()) as { id: string };

    try {
      const escalation = await grant(analyst, {
        principalKind: 'user',
        principalId: SEED.users.guest.id,
        resourceType: 'area',
        resourceId: SEED.areas.billing,
        roleKey: 'editor',
        canViewRestricted: true,
      });
      expect(escalation.status()).toBe(403);
      expect(await errorCode(escalation)).toBe('escalation');

      // R9: nobody may make a guest a manager.
      const guestManager = await grant(owner, {
        principalKind: 'user',
        principalId: SEED.users.guest.id,
        resourceType: 'area',
        resourceId: SEED.areas.billing,
        roleKey: 'manager',
      });
      expect(guestManager.status()).toBe(400);
      expect(await errorCode(guestManager)).toBe('guest_cannot_manage');

      // An area manager sees Billing's grants, not the project's.
      const scoped = await accessOf(analyst);
      expect(scoped.canManage).toBe(true);
      const granted = scoped.entries.flatMap((e) => e.grants.map((g) => g.resourceId));
      expect(granted).not.toContain(P);
    } finally {
      const removed = await owner.api.delete(`/api/grants/${managerGrant}`, {
        headers: write(owner),
      });
      expect(removed.status()).toBe(204);
    }
  });

  test('an email invite is a pending grant, listed by address, and removing it revokes it', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const response = await grant(owner, {
      principalKind: 'email_invite',
      principalId: 'New@Example.test',
      resourceType: 'project',
      resourceId: P,
      roleKey: 'viewer',
    });
    expect(response.status(), await response.text()).toBe(201);
    const { id } = (await response.json()) as { id: string };

    try {
      const pending = (await accessOf(owner)).entries.find(
        (e) => e.principal.kind === 'email_invite',
      );
      expect(pending?.principal.id).toBe('new@example.test');
      expect(pending?.grants.map((g) => g.roleKey)).toEqual(['viewer']);
    } finally {
      const removed = await owner.api.delete(`/api/grants/${id}`, { headers: write(owner) });
      expect(removed.status()).toBe(204);
    }
    expect((await accessOf(owner)).entries.some((e) => e.principal.kind === 'email_invite')).toBe(
      false,
    );
  });

  test('a share link is returned once, listed without its token, and revoked with its grant', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const created = await owner.api.post(`/api/projects/${P}/share-links`, {
      headers: write(owner),
      data: {
        resourceType: 'area',
        resourceId: SEED.areas.billing,
        expiresAt: null,
        password: 'hunter2hunter2',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { link, url } = (await created.json()) as {
      link: { id: string; hasPassword: boolean };
      url: string;
    };
    expect(url).toMatch(/\/s\/[\w-]{40,}$/);
    expect(link.hasPassword).toBe(true);

    const listed = await owner.api.get(`/api/projects/${P}/share-links`);
    const listText = await listed.text();
    expect(listText).toContain(link.id);
    expect(listText, 'the token is never stored, so it can never be listed').not.toContain(
      url.split('/s/')[1] ?? '',
    );

    // The link's grant is not in "Who has access" (R25): links have their own section.
    const access = await accessOf(owner);
    expect(access.entries.some((e) => e.principal.id === link.id)).toBe(false);

    const revoked = await owner.api.delete(`/api/share-links/${link.id}`, {
      headers: write(owner),
    });
    expect(revoked.status()).toBe(204);
    expect(await (await owner.api.get(`/api/projects/${P}/share-links`)).text()).not.toContain(
      link.id,
    );
  });

  test('an access request is 202 for anything, and approval is a real grant', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const dana = await signIn(SEED_EMAILS.freelancer);

    // The non-oracle: a project that does not exist gets the same answer.
    const ghost = await dana.api.post('/api/access-requests', {
      headers: write(dana),
      data: {
        projectId: 'prj_does_not_exist_000001',
        resourceType: 'project',
        resourceId: 'prj_does_not_exist_000001',
      },
    });
    expect(ghost.status()).toBe(202);

    // `products` reaches Dana as a stub (workflow 4); the stub's real id is the target.
    const asked = await dana.api.post('/api/access-requests', {
      headers: write(dana),
      data: {
        projectId: P,
        resourceType: 'entity',
        resourceId: SEED.entities.products,
        message: 'for the invoice FK',
      },
    });
    expect(asked.status()).toBe(202);

    const pending = await owner.api.get(`/api/projects/${P}/access-requests`);
    const { requests } = (await pending.json()) as {
      requests: { id: string; resourceId: string; requesterEmail: string; resourceName: string }[];
    };
    const request = requests.find((r) => r.resourceId === SEED.entities.products);
    expect(request?.requesterEmail).toBe(SEED_EMAILS.freelancer);
    expect(request?.resourceName).toBe('products');

    const approved = await owner.api.post(`/api/access-requests/${request?.id ?? ''}/approve`, {
      headers: write(owner),
      data: { roleKey: 'viewer' },
    });
    expect(approved.status(), await approved.text()).toBe(204);

    const grantId = (await accessOf(owner)).entries
      .find((e) => e.principal.id === SEED.users.guest.id)
      ?.grants.find((g) => g.resourceId === SEED.entities.products)?.id;
    try {
      // The generation bump means the very next read sees it: no stale map.
      const ir = await fetchIr(dana, P);
      expect(ir.objects.entity[SEED.entities.products]?.name).toBe('products');
    } finally {
      expect(grantId).toBeDefined();
      const removed = await owner.api.delete(`/api/grants/${grantId ?? ''}`, {
        headers: write(owner),
      });
      expect(removed.status()).toBe(204);
    }
    const after = await fetchIr(dana, P);
    expect(after.objects.entity[SEED.entities.products]?.name).toBe('');
  });

  test('a denied request is closed and leaves no grant', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const dana = await signIn(SEED_EMAILS.freelancer);
    await dana.api.post('/api/access-requests', {
      headers: write(dana),
      data: { projectId: P, resourceType: 'area', resourceId: SEED.areas.catalog },
    });

    const { requests } = (await (
      await owner.api.get(`/api/projects/${P}/access-requests`)
    ).json()) as {
      requests: { id: string; resourceId: string }[];
    };
    const request = requests.find((r) => r.resourceId === SEED.areas.catalog);
    expect(request).toBeDefined();

    const denied = await owner.api.post(`/api/access-requests/${request?.id ?? ''}/deny`, {
      headers: write(owner),
      data: { decisionNote: 'Catalog is vendor-confidential' },
    });
    expect(denied.status()).toBe(204);

    const again = await owner.api.post(`/api/access-requests/${request?.id ?? ''}/deny`, {
      headers: write(owner),
      data: { decisionNote: null },
    });
    expect(again.status(), 'a decided request is gone, not re-decidable').toBe(404);
  });
});
