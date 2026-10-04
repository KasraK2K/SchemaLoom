import { expect, test } from '@playwright/test';
import { signIn, signedInPage, write, type Session } from '../fixtures/api';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Roadmap 19 (`docs/phase19/DESIGN.md`): one grant on a workspace reaches every project in
 * it, including projects created later; a project's own grant for the same person still
 * decides inside that project (nearest level wins); only owners grant workspaces.
 */

async function createWorkspace(owner: Session, name: string): Promise<string> {
  const created = await owner.api.post(`/api/organizations/${SEED.orgSlug}/workspaces`, {
    headers: write(owner),
    data: { name },
  });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

async function createProject(owner: Session, workspaceId: string, name: string): Promise<string> {
  const created = await owner.api.post('/api/projects', {
    headers: write(owner),
    data: {
      organizationId: SEED.orgId,
      workspaceId,
      name,
      engineId: 'postgresql',
      engineVersion: '16',
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  return ((await created.json()) as { id: string }).id;
}

/** The analyst's role per project, from the project list (absent = can't open it). */
async function rolesOf(session: Session): Promise<Map<string, string>> {
  const list = (await (
    await session.api.get(`/api/organizations/${SEED.orgSlug}/projects`)
  ).json()) as { id: string; role: string }[];
  return new Map(list.map((p) => [p.id, p.role]));
}

test.describe('workflow 20 — workspace sharing', () => {
  test('a workspace grant reaches later projects; a project grant narrows it; removal ends it', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const stamp = String(Date.now());
    const owner = await signIn(SEED_EMAILS.owner);
    const analyst = await signIn(SEED_EMAILS.analyst);
    const workspaceName = `w20 ${stamp}`;
    const workspaceId = await createWorkspace(owner, workspaceName);
    const first = await createProject(owner, workspaceId, `w20 first ${stamp}`);

    // Invisible is 404 (CLAUDE.md), before any grant.
    expect((await analyst.api.get(`/api/projects/${first}/ir`)).status()).toBe(404);

    // The owner shares the workspace in Settings → Workspaces.
    const page = await signedInPage(browser, SEED_EMAILS.owner);
    await page.goto(`/${SEED.orgSlug}/settings/workspaces`);
    await page.waitForLoadState('networkidle');
    const section = page.getByRole('region', { name: `Share ${workspaceName}` });
    await section
      .getByLabel(`Person or group for ${workspaceName}`)
      .selectOption({ label: `${SEED.users.member.name} (${SEED_EMAILS.analyst})` });
    await section.getByLabel(`Role for ${workspaceName}`).selectOption({ label: 'Editor' });
    await section.getByRole('button', { name: 'Share' }).click();
    await expect(section.getByRole('status')).toContainText('every project');
    await expect(
      section.getByRole('listitem').filter({ hasText: SEED.users.member.name }),
    ).toBeVisible();

    expect((await analyst.api.get(`/api/projects/${first}/ir`)).status()).toBe(200);
    // A project created afterwards is covered too.
    const later = await createProject(owner, workspaceId, `w20 later ${stamp}`);
    let roles = await rolesOf(analyst);
    expect(roles.get(first)).toBe('editor');
    expect(roles.get(later)).toBe('editor');

    // Nearest level wins: Viewer on `later` itself narrows the workspace's Editor there only.
    const narrowed = await owner.api.post(`/api/projects/${later}/grants`, {
      headers: write(owner),
      data: {
        principalKind: 'user',
        principalId: SEED.users.member.id,
        resourceType: 'project',
        resourceId: later,
        roleKey: 'viewer',
        canUseAi: false,
        canViewRestricted: false,
      },
    });
    expect(narrowed.status(), await narrowed.text()).toBe(201);
    roles = await rolesOf(analyst);
    expect(roles.get(first)).toBe('editor');
    expect(roles.get(later)).toBe('viewer');

    // The project's "Who has access" list shows where the Editor comes from.
    const access = (await (await owner.api.get(`/api/projects/${first}/access`)).json()) as {
      entries: {
        principal: { id: string };
        grants: { resourceType: string; resourceName: string }[];
      }[];
    };
    const mine = access.entries.find((e) => e.principal.id === SEED.users.member.id);
    expect(mine?.grants).toContainEqual(
      expect.objectContaining({ resourceType: 'workspace', resourceName: workspaceName }),
    );

    // Removing the workspace grant ends access to `first`; `later` keeps its own grant.
    const grants = (await (
      await owner.api.get(`/api/organizations/${SEED.orgSlug}/workspaces/${workspaceId}/grants`)
    ).json()) as { id: string }[];
    for (const g of grants) {
      const removed = await owner.api.delete(
        `/api/organizations/${SEED.orgSlug}/workspace-grants/${g.id}`,
        { headers: write(owner) },
      );
      expect(removed.status()).toBe(204);
    }
    expect((await analyst.api.get(`/api/projects/${first}/ir`)).status()).toBe(404);
    expect((await rolesOf(analyst)).get(later)).toBe('viewer');

    // The org audit log has the trail.
    const audit = (await (
      await owner.api.get(`/api/organizations/${SEED.orgSlug}/audit-log?action=workspace_grant.`)
    ).json()) as { rows: { action: string }[] };
    expect(audit.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(['workspace_grant.created', 'workspace_grant.deleted']),
    );
  });

  test('only owners grant workspaces', async () => {
    const owner = await signIn(SEED_EMAILS.owner);
    const workspaceId = await createWorkspace(owner, `w20 admin ${String(Date.now())}`);
    const admin = await signIn(SEED_EMAILS.admin);
    const refused = await admin.api.post(
      `/api/organizations/${SEED.orgSlug}/workspaces/${workspaceId}/grants`,
      {
        headers: write(admin),
        data: {
          principalKind: 'user',
          principalId: SEED.users.admin.id,
          roleKey: 'manager',
          canUseAi: true,
          canViewRestricted: true,
        },
      },
    );
    expect(refused.status()).toBe(403);
  });
});
