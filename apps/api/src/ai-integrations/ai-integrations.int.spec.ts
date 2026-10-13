import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PermissionResolver } from '../access';
import type { AiProvider } from '../ai/ai.provider';
import { decryptSecret } from '../auth/totp';
import type { AppEnv } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AiIntegrationsService } from './ai-integrations.service';
import { AiRouter } from './ai-router.service';

/**
 * Roadmap 24 §2, §3.5, §3.6 against a real Postgres (`DATABASE_URL_TEST`): who manages which
 * integrations, grants and choices, what the audit log records, and that no key ever leaves.
 */

const url = process.env.DATABASE_URL_TEST;
const KEY = randomBytes(32).toString('base64');
const O = 'org_aii';
const Y = 'org_aii_y';
const OWNER = 'usr_aii_o';
const ADMIN = 'usr_aii_a';
const MEMBER = 'usr_aii_m';
const OUTSIDER = 'usr_aii_y';
const USERS = [OWNER, ADMIN, MEMBER, OUTSIDER];
const PX = 'prj_aii_x';
const PY = 'prj_aii_y';
/** in org O, but the admin can't open it (owners see every project, R13) */
const PZ = 'prj_aii_z';
const SRV = `aii_srv_${O}`;
const SK = 'sk-test-a1b2';

const ENV = {
  ANTHROPIC_API_KEY: 'env-key',
  AI_MODEL: 'claude-sonnet-5-5',
  AI_SERVER_MODELS: [],
  AI_ALLOW_PRIVATE_HOSTS: false,
  SECRETS_ENCRYPTION_KEY: KEY,
};
const config = (env: Record<string, unknown>): ConfigService<AppEnv, true> =>
  ({ get: (key: string) => env[key] }) as unknown as ConfigService<AppEnv, true>;

const org = (userId: string, orgSlug = O) => ({ kind: 'org' as const, userId, orgSlug });
const me = (userId: string) => ({ kind: 'me' as const, userId });
const openai = { provider: 'openai' as const, name: 'OpenAI', apiKey: SK, models: ['gpt-x'] };

describe.skipIf(url === undefined)('AiIntegrationsService (roadmap 24 §3.5)', () => {
  const db = new PrismaClient({ datasourceUrl: url });
  const prisma = db as unknown as PrismaService;
  const listModels = vi.fn<AiProvider['listModels']>();
  const provider = { listModels } as unknown as AiProvider;
  const resolver = {
    resolveProject: vi.fn((_subject: unknown, projectId: string) => Promise.resolve({ projectId })),
    resolveProjects: vi.fn((_subject: unknown, ids: string[]) =>
      Promise.resolve(new Map(ids.map((projectId) => [projectId, { projectId }]))),
    ),
    canOpenProject: vi.fn((map: { projectId: string }) => map.projectId === PX),
  } as unknown as PermissionResolver;
  const build = (env: Record<string, unknown>) => {
    const c = config(env);
    return new AiIntegrationsService(prisma, c, provider, new AiRouter(prisma, c), resolver);
  };
  let svc = build(ENV);

  const audits = (action: string) =>
    db.auditLog.findMany({ where: { action, actorUserId: { in: USERS } } });

  const reset = async (): Promise<void> => {
    svc = build(ENV);
    listModels.mockReset().mockResolvedValue(['gpt-x', 'gpt-y']);
    await db.auditLog.deleteMany({ where: { actorUserId: { in: USERS } } });
    await db.aiAbilityChoice.deleteMany({ where: { organizationId: { in: [O, Y] } } });
    await db.aiIntegration.deleteMany({
      where: {
        id: { not: SRV },
        OR: [{ organizationId: { in: [O, Y] } }, { ownerUserId: { in: USERS } }],
      },
    });
    await db.aiIntegrationGrant.deleteMany({ where: { integrationId: SRV } });
    await db.organization.update({ where: { id: O }, data: { settings: {} } });
  };

  beforeAll(async () => {
    await db.organization.deleteMany({ where: { id: { in: [O, Y] } } });
    await db.user.deleteMany({ where: { id: { in: USERS } } });
    await db.organization.createMany({
      data: [
        { id: O, name: O, slug: O },
        { id: Y, name: Y, slug: Y },
      ],
    });
    await db.user.createMany({
      data: USERS.map((id) => ({ id, email: `${id}@aii.test`, name: id })),
    });
    await db.orgMember.createMany({
      data: [
        { organizationId: O, userId: OWNER, role: 'owner' },
        { organizationId: O, userId: ADMIN, role: 'admin' },
        { organizationId: O, userId: MEMBER, role: 'member' },
        { organizationId: Y, userId: OUTSIDER, role: 'owner' },
        { organizationId: Y, userId: MEMBER, role: 'member' },
      ],
    });
    for (const [orgId, projectId] of [
      [O, PX],
      [O, PZ],
      [Y, PY],
    ] as const) {
      await db.workspace.create({
        data: { id: `ws_${projectId}`, organizationId: orgId, name: 'W', slug: projectId },
      });
      await db.project.create({
        data: {
          id: projectId,
          organizationId: orgId,
          workspaceId: `ws_${projectId}`,
          name: `Project ${projectId}`,
          slug: 'p',
          engineId: 'postgresql',
          engineVersion: '16',
          enginePluginVersion: '1.0.0',
        },
      });
    }
    // What the migration (and org creation) does for every org.
    await db.aiIntegration.create({
      data: {
        id: SRV,
        organizationId: O,
        source: 'server',
        provider: 'anthropic',
        name: 'Server default',
      },
    });
  });

  beforeEach(reset);

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { actorUserId: { in: USERS } } });
    await db.organization.deleteMany({ where: { id: { in: [O, Y] } } });
    await db.user.deleteMany({ where: { id: { in: USERS } } });
    await db.$disconnect();
  });

  it('1. owner and admin create org integrations; a member gets 404; no key in the view', async () => {
    const byOwner = await svc.create(org(OWNER), openai);
    const byAdmin = await svc.create(org(ADMIN), { ...openai, name: 'Second' });
    for (const view of [byOwner, byAdmin]) {
      expect(view).toMatchObject({
        provider: 'openai',
        source: 'custom',
        personal: false,
        keyHint: 'a1b2',
        models: ['gpt-x'],
        status: 'unchecked',
        capabilities: { caching: true, thinking: false, fallback: false },
      });
      expect(view).not.toHaveProperty('apiKeyEnc');
      expect(view).not.toHaveProperty('apiKey');
      expect(JSON.stringify(view)).not.toContain('sk-test');
    }
    await expect(svc.create(org(MEMBER), openai)).rejects.toMatchObject({
      status: 404,
      response: { code: 'not_found' },
    });
    await expect(svc.list(org(MEMBER))).rejects.toMatchObject({ status: 404 });
    await expect(svc.create(org(OUTSIDER), openai)).rejects.toMatchObject({ status: 404 });
  });

  it('2. stores the key encrypted and audits the create without it', async () => {
    const view = await svc.create(org(OWNER), openai);
    const row = await db.aiIntegration.findUniqueOrThrow({ where: { id: view.id } });
    expect(row.apiKeyEnc).not.toBeNull();
    expect(row.apiKeyEnc).not.toContain(SK);
    expect(decryptSecret(row.apiKeyEnc ?? '', KEY).toString()).toBe(SK);
    const [created] = await audits('ai_integration.created');
    expect(created).toMatchObject({
      organizationId: O,
      actorUserId: OWNER,
      resourceType: 'ai_integration',
      resourceId: view.id,
      metadata: { provider: 'openai', name: 'OpenAI', models: ['gpt-x'] },
    });
    expect(JSON.stringify(created?.metadata)).not.toContain('sk-test');
    expect(JSON.stringify(created?.metadata)).not.toContain('a1b2');
  });

  it('3. a key rotation is audited as such; the server row is read-only', async () => {
    const view = await svc.create(org(OWNER), openai);
    const rotated = await svc.update(org(ADMIN), view.id, { apiKey: 'sk-new-key-9z9z' });
    expect(rotated.keyHint).toBe('9z9z');
    const row = await db.aiIntegration.findUniqueOrThrow({ where: { id: view.id } });
    expect(decryptSecret(row.apiKeyEnc ?? '', KEY).toString()).toBe('sk-new-key-9z9z');
    const [rotation] = await audits('ai_integration.key_rotated');
    expect(rotation).toMatchObject({ resourceId: view.id, actorUserId: ADMIN });
    expect(JSON.stringify(rotation?.metadata)).not.toContain('sk-new');

    const renamed = await svc.update(org(OWNER), view.id, { name: 'Renamed', models: ['gpt-y'] });
    expect(renamed).toMatchObject({ name: 'Renamed', models: ['gpt-y'], keyHint: '9z9z' });
    expect(await audits('ai_integration.updated')).toHaveLength(1);

    // A key under 12 characters gets no hint: four characters would be too much of it.
    const short = await svc.update(org(OWNER), view.id, { apiKey: 'sk-short1' });
    expect(short.keyHint).toBeNull();
    expect(
      (await db.aiIntegration.findUniqueOrThrow({ where: { id: view.id } })).keyHint,
    ).toBeNull();
    const shortCreated = await svc.create(org(OWNER), { ...openai, apiKey: 'sk-12345678' });
    expect(shortCreated.keyHint).toBeNull();

    await expect(
      svc.update(org(OWNER), view.id, { baseUrl: 'https://example.com/v1' }),
    ).rejects.toMatchObject({ status: 422, response: { code: 'ai_base_url_not_allowed' } });
    await expect(svc.update(org(OWNER), SRV, { name: 'Mine' })).rejects.toMatchObject({
      status: 409,
      response: { code: 'ai_server_integration_readonly' },
    });
    await expect(svc.remove(org(OWNER), SRV)).rejects.toMatchObject({
      status: 409,
      response: { code: 'ai_server_integration_readonly' },
    });

    await svc.remove(org(OWNER), view.id);
    expect(await db.aiIntegration.findUnique({ where: { id: view.id } })).toBeNull();
    expect(await audits('ai_integration.deleted')).toHaveLength(1);
  });

  it('4. test stores ok with the fetched models, or failing with the key scrubbed', async () => {
    const view = await svc.create(org(OWNER), openai);
    const ok = await svc.test(org(OWNER), view.id);
    expect(ok).toMatchObject({ status: 'ok', lastError: null, fetchedModels: ['gpt-x', 'gpt-y'] });
    expect(ok.lastCheckedAt).toBeInstanceOf(Date);
    expect(listModels).toHaveBeenCalledWith({
      source: 'custom',
      provider: 'openai',
      apiKey: SK,
      baseUrl: null,
    });
    // It never changes allowed_models by itself (§4.4).
    expect(ok.models).toEqual(['gpt-x']);

    listModels.mockRejectedValueOnce(new Error(`bad ${SK}`));
    const failing = await svc.test(org(OWNER), view.id);
    expect(failing).toMatchObject({ status: 'failing', lastError: 'bad ***', fetchedModels: [] });
    const row = await db.aiIntegration.findUniqueOrThrow({ where: { id: view.id } });
    expect(row).toMatchObject({ status: 'failing', lastError: 'bad ***' });
    const tested = await audits('ai_integration.tested');
    expect(
      tested
        .map((a) => a.metadata)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual([{ ok: false }, { ok: true }]);

    // The server row tests with the env key.
    await svc.test(org(OWNER), SRV);
    expect(listModels).toHaveBeenLastCalledWith({
      source: 'server',
      provider: 'anthropic',
      apiKey: 'env-key',
      baseUrl: null,
    });
  });

  it('5. a private base URL is refused unless AI_ALLOW_PRIVATE_HOSTS', async () => {
    const local = {
      provider: 'openai_compatible' as const,
      name: 'Ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: ['llama3'],
    };
    await expect(svc.create(org(OWNER), local)).rejects.toMatchObject({
      status: 422,
      response: { code: 'ai_private_base_url' },
    });
    const view = await build({ ...ENV, AI_ALLOW_PRIVATE_HOSTS: true }).create(org(OWNER), local);
    expect(view).toMatchObject({ baseUrl: 'http://127.0.0.1:11434/v1', keyHint: null });
    // Moving it onto a private host is refused the same way.
    await expect(
      svc.update(org(OWNER), view.id, { baseUrl: 'http://10.0.0.5:11434/v1' }),
    ).rejects.toMatchObject({ status: 422, response: { code: 'ai_private_base_url' } });
  });

  it('6. grants stay inside the org and are unique; a personal integration has none', async () => {
    const view = await svc.create(org(OWNER), openai);
    await expect(
      svc.addGrant(OWNER, O, view.id, { projectId: PY, userId: null }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.addGrant(OWNER, O, view.id, { projectId: null, userId: OUTSIDER }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.addGrant(MEMBER, O, view.id, { projectId: PX, userId: null }),
    ).rejects.toMatchObject({ status: 404 });

    const grant = await svc.addGrant(ADMIN, O, view.id, { projectId: PX, userId: MEMBER });
    expect(grant).toMatchObject({
      projectId: PX,
      projectName: `Project ${PX}`,
      userId: MEMBER,
      userName: MEMBER,
    });
    await expect(
      svc.addGrant(ADMIN, O, view.id, { projectId: PX, userId: MEMBER }),
    ).rejects.toMatchObject({ status: 409, response: { code: 'ai_grant_exists' } });
    const all = await svc.addGrant(OWNER, O, view.id, { projectId: null, userId: null });
    expect(all).toMatchObject({ projectId: null, projectName: null, userId: null, userName: null });
    expect((await svc.listGrants(OWNER, O, view.id)).map((g) => g.id).sort()).toEqual(
      [grant.id, all.id].sort(),
    );
    // The server row is grantable.
    await svc.addGrant(OWNER, O, SRV, { projectId: null, userId: null });

    await svc.removeGrant(OWNER, O, view.id, grant.id);
    expect((await svc.listGrants(OWNER, O, view.id)).map((g) => g.id)).toEqual([all.id]);
    await expect(svc.removeGrant(OWNER, O, view.id, grant.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await audits('ai_integration_grant.added')).toHaveLength(3);
    expect(await audits('ai_integration_grant.removed')).toHaveLength(1);

    // Another org's owner can't reach O's integration through their own slug.
    await expect(svc.listGrants(OUTSIDER, Y, view.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.addGrant(OUTSIDER, Y, view.id, { projectId: null, userId: null }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(svc.update(org(OUTSIDER, Y), view.id, { name: 'x' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(svc.remove(org(OUTSIDER, Y), view.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.test(org(OUTSIDER, Y), view.id)).rejects.toMatchObject({ status: 404 });

    const personal = await svc.create(me(OWNER), openai);
    await expect(svc.listGrants(OWNER, O, personal.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.addGrant(OWNER, O, personal.id, { projectId: null, userId: null }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('6b. an admin sees no grant on a project they cannot open (R13); the owner does', async () => {
    const view = await svc.create(org(OWNER), openai);
    const hidden = await svc.addGrant(OWNER, O, view.id, { projectId: PZ, userId: null });
    expect(hidden).toMatchObject({ projectId: PZ, projectName: `Project ${PZ}` });
    const all = await svc.addGrant(ADMIN, O, view.id, { projectId: null, userId: null });

    expect((await svc.listGrants(ADMIN, O, view.id)).map((g) => g.id)).toEqual([all.id]);
    expect(JSON.stringify(await svc.listGrants(ADMIN, O, view.id))).not.toContain(PZ);
    await expect(
      svc.addGrant(ADMIN, O, view.id, { projectId: PZ, userId: MEMBER }),
    ).rejects.toMatchObject({ status: 404, response: { code: 'not_found' } });
    // The same 404 as a project that doesn't exist.
    await expect(
      svc.addGrant(ADMIN, O, view.id, { projectId: 'prj_aii_missing', userId: null }),
    ).rejects.toMatchObject({ status: 404, response: { code: 'not_found' } });
    await expect(svc.removeGrant(ADMIN, O, view.id, hidden.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(await db.aiIntegrationGrant.findUnique({ where: { id: hidden.id } })).not.toBeNull();

    expect((await svc.listGrants(OWNER, O, view.id)).map((g) => g.id).sort()).toEqual(
      [hidden.id, all.id].sort(),
    );
    await svc.removeGrant(OWNER, O, view.id, hidden.id);
    expect(await db.aiIntegrationGrant.findUnique({ where: { id: hidden.id } })).toBeNull();
  });

  it('7. a personal integration is its owner’s alone', async () => {
    const mine = await svc.create(me(MEMBER), openai);
    expect(mine).toMatchObject({ personal: true, keyHint: 'a1b2' });
    const [created] = await audits('ai_integration.created');
    expect(created).toMatchObject({ organizationId: null, actorUserId: MEMBER });

    for (const other of [OWNER, ADMIN]) {
      await expect(svc.update(me(other), mine.id, { name: 'x' })).rejects.toMatchObject({
        status: 404,
      });
      await expect(svc.remove(me(other), mine.id)).rejects.toMatchObject({ status: 404 });
      await expect(svc.test(me(other), mine.id)).rejects.toMatchObject({ status: 404 });
      await expect(svc.update(org(other), mine.id, { name: 'x' })).rejects.toMatchObject({
        status: 404,
      });
    }
    expect((await svc.list(org(OWNER))).map((i) => i.id)).not.toContain(mine.id);
    expect((await svc.list(me(OWNER))).map((i) => i.id)).not.toContain(mine.id);
    expect((await svc.list(me(MEMBER))).map((i) => i.id)).toEqual([mine.id]);
    // The org's server row is not the member's to manage.
    await expect(svc.update(me(MEMBER), SRV, { name: 'x' })).rejects.toMatchObject({ status: 404 });

    await svc.remove(me(MEMBER), mine.id);
    expect(await svc.list(me(MEMBER))).toEqual([]);
  });

  it('8. choices check the integration, the model, the lock and the project', async () => {
    const view = await svc.create(org(OWNER), openai);
    const personal = await svc.create(me(MEMBER), { ...openai, models: ['gpt-p'] });
    const scopeOrg = { kind: 'org' as const, userId: ADMIN, orgSlug: O };
    const scopeProject = { kind: 'project' as const, userId: OWNER, projectId: PX };
    const scopeMe = (projectId: string | null) => ({
      kind: 'me' as const,
      userId: MEMBER,
      orgSlug: O,
      projectId,
    });

    await expect(
      svc.putChoice(scopeOrg, {
        ability: 'chat',
        integrationId: view.id,
        model: 'gpt-z',
        locked: false,
      }),
    ).rejects.toMatchObject({ status: 422, response: { code: 'ai_model_not_allowed' } });
    for (const scope of [scopeOrg, scopeProject]) {
      await expect(
        svc.putChoice(scope, {
          ability: 'chat',
          integrationId: personal.id,
          model: 'gpt-p',
          locked: false,
        }),
      ).rejects.toMatchObject({ status: 422, response: { code: 'ai_integration_not_in_org' } });
    }
    await expect(
      svc.putChoice(scopeMe(null), {
        ability: 'chat',
        integrationId: view.id,
        model: 'gpt-x',
        locked: true,
      }),
    ).rejects.toMatchObject({ status: 422, response: { code: 'ai_lock_not_allowed' } });
    await expect(
      svc.putChoice(scopeMe(PY), {
        ability: 'chat',
        integrationId: view.id,
        model: 'gpt-x',
        locked: false,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.putChoice(
        { kind: 'org', userId: MEMBER, orgSlug: O },
        { ability: 'chat', integrationId: view.id, model: 'gpt-x', locked: false },
      ),
    ).rejects.toMatchObject({ status: 404 });

    const lockedOrg = await svc.putChoice(scopeOrg, {
      ability: 'chat',
      integrationId: view.id,
      model: 'gpt-x',
      locked: true,
    });
    expect(lockedOrg).toEqual({
      ability: 'chat',
      projectId: null,
      userId: null,
      integrationId: view.id,
      model: 'gpt-x',
      locked: true,
    });
    // A second put on the same scope updates rather than duplicates.
    await svc.putChoice(scopeOrg, {
      ability: 'chat',
      integrationId: SRV,
      model: 'claude-sonnet-5-5',
      locked: false,
    });
    expect(await svc.listChoices(scopeOrg)).toEqual([
      {
        ability: 'chat',
        projectId: null,
        userId: null,
        integrationId: SRV,
        model: 'claude-sonnet-5-5',
        locked: false,
      },
    ]);
    const project = await svc.putChoice(scopeProject, {
      ability: 'schema_draft',
      integrationId: view.id,
      model: 'gpt-x',
      locked: true,
    });
    expect(project).toMatchObject({ projectId: PX, userId: null, locked: true });

    // Another org's integration is not this org's to choose.
    const foreign = await svc.create(org(OUTSIDER, Y), openai);
    for (const scope of [scopeOrg, scopeProject, scopeMe(null)]) {
      await expect(
        svc.putChoice(scope, {
          ability: 'chat',
          integrationId: foreign.id,
          model: 'gpt-x',
          locked: false,
        }),
      ).rejects.toMatchObject({ status: 422, response: { code: 'ai_integration_not_in_org' } });
    }

    // A member picks only what they can use, checked before the model (no probing).
    for (const model of ['gpt-x', 'no-such-model']) {
      await expect(
        svc.putChoice(scopeMe(PX), {
          ability: 'chat',
          integrationId: view.id,
          model,
          locked: false,
        }),
      ).rejects.toMatchObject({ status: 422, response: { code: 'ai_integration_not_in_org' } });
    }
    // Personal integrations are off by default.
    await expect(
      svc.putChoice(scopeMe(null), {
        ability: 'chat',
        integrationId: personal.id,
        model: 'gpt-p',
        locked: false,
      }),
    ).rejects.toMatchObject({ status: 422, response: { code: 'ai_integration_not_in_org' } });
    await svc.addGrant(OWNER, O, view.id, { projectId: null, userId: MEMBER });
    await db.organization.update({
      where: { id: O },
      data: { settings: { ai: { allowPersonalIntegrations: true } } },
    });
    await expect(
      svc.putChoice(scopeMe(PX), {
        ability: 'chat',
        integrationId: view.id,
        model: 'no-such-model',
        locked: false,
      }),
    ).rejects.toMatchObject({ status: 422, response: { code: 'ai_model_not_allowed' } });

    const mine = await svc.putChoice(scopeMe(null), {
      ability: 'chat',
      integrationId: personal.id,
      model: 'gpt-p',
      locked: false,
    });
    expect(mine).toMatchObject({ projectId: null, userId: MEMBER, integrationId: personal.id });
    await svc.putChoice(scopeMe(PX), {
      ability: 'chat',
      integrationId: view.id,
      model: 'gpt-x',
      locked: false,
    });

    const set = await audits('ai_choice.set');
    expect(set).toHaveLength(5);
    expect(set.find((a) => a.projectId === PX && a.actorUserId === OWNER)).toMatchObject({
      organizationId: O,
      resourceType: 'ai_choice',
      metadata: {
        ability: 'schema_draft',
        projectId: PX,
        userId: null,
        model: 'gpt-x',
        locked: true,
      },
    });

    expect(await svc.listChoices(scopeProject)).toHaveLength(1);
    // The Account page lists the member's defaults and per-project overrides.
    const listed = await svc.listChoices(scopeMe(null));
    expect(listed.choices.map((c) => c.projectId).sort()).toEqual([null, PX].sort());
    expect((await svc.listChoices(scopeMe(PX))).choices.map((c) => c.projectId)).toEqual([PX]);

    await svc.clearChoice(scopeMe(PX), 'chat');
    await svc.clearChoice(scopeProject, 'schema_draft');
    expect((await svc.listChoices(scopeMe(PX))).choices).toEqual([]);
    expect(await svc.listChoices(scopeProject)).toEqual([]);
    const cleared = await audits('ai_choice.cleared');
    expect(cleared).toHaveLength(2);
    expect(
      cleared.find((a) => a.projectId === PX && a.actorUserId === OWNER)?.metadata,
    ).toMatchObject({
      ability: 'schema_draft',
      locked: true,
    });
  });

  it('8b. the /me listing offers what the caller can use and the personal policy', async () => {
    const granted = await svc.create(org(OWNER), { ...openai, name: 'Granted' });
    const projectOnly = await svc.create(org(OWNER), { ...openai, name: 'Project only' });
    await svc.create(org(OWNER), { ...openai, name: 'Ungranted' });
    await svc.addGrant(OWNER, O, granted.id, { projectId: null, userId: MEMBER });
    await svc.addGrant(OWNER, O, projectOnly.id, { projectId: PX, userId: null });
    await svc.addGrant(OWNER, O, SRV, { projectId: null, userId: null });
    const mineOpenai = await svc.create(me(MEMBER), { ...openai, name: 'My OpenAI' });
    const mineGemini = await svc.create(me(MEMBER), {
      provider: 'gemini',
      name: 'My Gemini',
      apiKey: 'g-key-1234',
      models: ['gemini-x'],
    });
    await svc.create(me(OWNER), { ...openai, name: 'Not mine' });
    const scope = (projectId: string | null) => ({
      kind: 'me' as const,
      userId: MEMBER,
      orgSlug: O,
      projectId,
    });
    const ids = async (projectId: string | null) =>
      (await svc.listChoices(scope(projectId))).usableIntegrations.map((i) => i.id).sort();

    // Policy off: no personal integrations offered.
    const off = await svc.listChoices(scope(null));
    expect(off.personalAllowed).toBe(false);
    expect(await ids(null)).toEqual([granted.id, SRV].sort());
    expect(await ids(PX)).toEqual([granted.id, projectOnly.id, SRV].sort());
    expect(JSON.stringify(off)).not.toContain('sk-test');

    await db.organization.update({
      where: { id: O },
      data: { settings: { ai: { allowPersonalIntegrations: true } } },
    });
    expect((await svc.listChoices(scope(null))).personalAllowed).toBe(true);
    expect(await ids(null)).toEqual([granted.id, mineGemini.id, mineOpenai.id, SRV].sort());

    await db.organization.update({
      where: { id: O },
      data: {
        settings: { ai: { allowPersonalIntegrations: true, personalProviders: ['gemini'] } },
      },
    });
    expect(await ids(PX)).toEqual([granted.id, projectOnly.id, mineGemini.id, SRV].sort());

    // Without an env key the server row is not offered.
    svc = build({ ...ENV, ANTHROPIC_API_KEY: undefined });
    expect(await ids(null)).toEqual([granted.id, mineGemini.id].sort());
    // Another org's member can't read this org's listing.
    await expect(
      svc.listChoices({ kind: 'me', userId: OUTSIDER, orgSlug: O, projectId: null }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('9. the server row is listed only with ANTHROPIC_API_KEY, without key fields', async () => {
    const listed = await svc.list(org(OWNER));
    expect(listed.map((i) => i.id)).toEqual([SRV]);
    expect(listed[0]).toMatchObject({
      source: 'server',
      provider: 'anthropic',
      keyHint: null,
      baseUrl: null,
      models: ['claude-sonnet-5-5'],
    });
    expect(JSON.stringify(listed)).not.toContain('env-key');

    const keyless = build({ ...ENV, ANTHROPIC_API_KEY: undefined });
    expect(await keyless.list(org(OWNER))).toEqual([]);
    await expect(keyless.test(org(OWNER), SRV)).rejects.toMatchObject({ status: 404 });
    await expect(keyless.update(org(OWNER), SRV, { name: 'x' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      keyless.addGrant(OWNER, O, SRV, { projectId: null, userId: null }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
