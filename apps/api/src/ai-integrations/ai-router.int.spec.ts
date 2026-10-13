import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret } from '../auth/totp';
import type { AppEnv } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AiRouter } from './ai-router.service';

/**
 * Roadmap 24 §3 against a real Postgres (`DATABASE_URL_TEST`): the router loads the rows,
 * the pure resolver decides, and the key is decrypted on the way out.
 */

const url = process.env.DATABASE_URL_TEST;
const KEY = randomBytes(32).toString('base64');
const O = 'org_air';
const U = 'usr_air';
const OTHER = 'usr_air_other';
const P = 'prj_air';
const SRV = `aii_srv_${O}`;

const config = (env: Record<string, unknown>): ConfigService<AppEnv, true> =>
  ({
    get: (key: string) => env[key],
  }) as unknown as ConfigService<AppEnv, true>;
const ENV = {
  ANTHROPIC_API_KEY: 'env-key',
  AI_MODEL: 'claude-sonnet-5-5',
  AI_SERVER_MODELS: [],
  SECRETS_ENCRYPTION_KEY: KEY,
};

describe.skipIf(url === undefined)('AiRouter (roadmap 24 §3)', () => {
  const db = new PrismaClient({ datasourceUrl: url });
  const prisma = db as unknown as PrismaService;
  const router = new AiRouter(prisma, config(ENV));
  const routerWithoutKey = new AiRouter(prisma, config({ ...ENV, ANTHROPIC_API_KEY: undefined }));

  const reset = async (): Promise<void> => {
    await db.aiAbilityChoice.deleteMany({ where: { organizationId: O } });
    await db.aiIntegration.deleteMany({
      where: { id: { not: SRV }, OR: [{ organizationId: O }, { ownerUserId: { in: [U, OTHER] } }] },
    });
    await db.aiIntegrationGrant.deleteMany({ where: { integrationId: SRV } });
    await db.aiIntegrationGrant.create({ data: { integrationId: SRV } });
    await db.organization.update({ where: { id: O }, data: { settings: {} } });
    await db.aiIntegration.create({
      data: {
        id: 'aii_air',
        organizationId: O,
        source: 'custom',
        provider: 'openai',
        name: 'OpenAI',
        apiKeyEnc: encryptSecret(Buffer.from('sk-air'), KEY),
        allowedModels: ['gpt-x'],
      },
    });
  };

  beforeAll(async () => {
    await db.organization.deleteMany({ where: { id: O } });
    await db.user.deleteMany({ where: { id: { in: [U, OTHER] } } });
    await db.organization.create({ data: { id: O, name: O, slug: O } });
    await db.user.createMany({
      data: [
        { id: U, email: `${U}@air.test`, name: 'U' },
        { id: OTHER, email: `${OTHER}@air.test`, name: 'Other' },
      ],
    });
    await db.workspace.create({ data: { id: 'ws_air', organizationId: O, name: 'W', slug: 'w' } });
    await db.project.create({
      data: {
        id: P,
        organizationId: O,
        workspaceId: 'ws_air',
        name: 'P',
        slug: 'p',
        engineId: 'postgresql',
        engineVersion: '16',
        enginePluginVersion: '1.0.0',
      },
    });
    // What the migration does for every org.
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
    await db.organization.deleteMany({ where: { id: O } });
    await db.user.deleteMany({ where: { id: { in: [U, OTHER] } } });
    await db.$disconnect();
  });

  it('falls back to the server default with the env model', async () => {
    expect(await router.resolve(U, P, O, 'chat')).toMatchObject({
      integrationId: SRV,
      provider: 'anthropic',
      model: 'claude-sonnet-5-5',
      apiKey: 'env-key',
      source: 'server',
    });
  });

  it('uses a granted org default and decrypts its key', async () => {
    await db.aiIntegrationGrant.create({ data: { integrationId: 'aii_air', projectId: P } });
    await db.aiAbilityChoice.create({
      data: { organizationId: O, ability: 'chat', integrationId: 'aii_air', model: 'gpt-x' },
    });
    expect(await router.resolve(U, P, O, 'chat')).toMatchObject({
      integrationId: 'aii_air',
      model: 'gpt-x',
      apiKey: 'sk-air',
      personal: false,
    });
  });

  it('answers 503 ai_integration_undecryptable after SECRETS_ENCRYPTION_KEY rotated', async () => {
    await db.aiIntegrationGrant.create({ data: { integrationId: 'aii_air', projectId: P } });
    await db.aiAbilityChoice.create({
      data: { organizationId: O, ability: 'chat', integrationId: 'aii_air', model: 'gpt-x' },
    });
    const rotated = new AiRouter(
      prisma,
      config({ ...ENV, SECRETS_ENCRYPTION_KEY: randomBytes(32).toString('base64') }),
    );
    await expect(rotated.resolve(U, P, O, 'chat')).rejects.toMatchObject({
      status: 503,
      response: { code: 'ai_integration_undecryptable' },
    });
  });

  it('answers 503 ai_no_model without an env key and without grants', async () => {
    await db.aiIntegrationGrant.deleteMany({ where: { integrationId: SRV } });
    await expect(router.resolve(U, P, O, 'chat')).rejects.toMatchObject({
      status: 503,
      response: { code: 'ai_no_model' },
    });
    // The grant is back, but the server row is unusable without ANTHROPIC_API_KEY.
    await db.aiIntegrationGrant.create({ data: { integrationId: SRV } });
    await expect(routerWithoutKey.resolve(U, P, O, 'chat')).rejects.toMatchObject({
      status: 503,
      response: { code: 'ai_no_model' },
    });
  });

  it('answers 503 ai_locked_model_unavailable for a broken lock', async () => {
    // 'aii_air' has no grant, so the org-locked choice on it cannot be honoured.
    await db.aiAbilityChoice.create({
      data: {
        organizationId: O,
        ability: 'chat',
        integrationId: 'aii_air',
        model: 'gpt-x',
        locked: true,
      },
    });
    await expect(router.resolve(U, P, O, 'chat')).rejects.toMatchObject({
      status: 503,
      response: { code: 'ai_locked_model_unavailable', scope: 'org' },
    });
  });

  it('the job re-check returns null after the grant is revoked', async () => {
    const grant = await db.aiIntegrationGrant.create({
      data: { integrationId: 'aii_air', projectId: P },
    });
    expect(await router.usableTarget(U, P, O, 'aii_air', 'gpt-x')).toMatchObject({
      integrationId: 'aii_air',
      apiKey: 'sk-air',
    });
    expect(await router.usableTarget(U, P, O, 'aii_air', 'not-allowed')).toBeNull();
    await db.aiIntegrationGrant.delete({ where: { id: grant.id } });
    expect(await router.usableTarget(U, P, O, 'aii_air', 'gpt-x')).toBeNull();
  });

  it('options lists only usable integrations and never another user’s personal one', async () => {
    await db.organization.update({
      where: { id: O },
      data: { settings: { ai: { allowPersonalIntegrations: true } } },
    });
    for (const [id, owner] of [
      ['aii_air_mine', U],
      ['aii_air_theirs', OTHER],
    ] as const) {
      await db.aiIntegration.create({
        data: {
          id,
          ownerUserId: owner,
          source: 'custom',
          provider: 'openai',
          name: id,
          apiKeyEnc: encryptSecret(Buffer.from('sk-p'), KEY),
          allowedModels: ['gpt-p'],
        },
      });
    }
    await db.aiAbilityChoice.create({
      data: {
        organizationId: O,
        ability: 'chat',
        integrationId: 'aii_air',
        model: 'gpt-x',
        locked: true,
      },
    });
    const view = await router.options(U, P, O);
    // 'aii_air' is ungranted: not listed. The server row and the user's own row are.
    expect(view.integrations.map((i) => i.id).sort()).toEqual(['aii_air_mine', SRV].sort());
    expect(view.integrations.find((i) => i.id === 'aii_air_mine')).toMatchObject({
      personal: true,
      models: ['gpt-p'],
      capabilities: { caching: true, thinking: false, fallback: false },
    });
    expect(view.abilities.map((a) => a.id)).toEqual(['chat', 'schema_draft', 'doc_drafts']);
    expect(view.abilities.find((a) => a.id === 'chat')).toMatchObject({
      resolved: null,
      lock: { scope: 'org', usable: false },
    });
    expect(view.abilities.find((a) => a.id === 'doc_drafts')).toMatchObject({
      resolved: { integrationId: SRV, step: 'server' },
      lock: null,
    });
    // A personal target is marked so the provider keeps it off private hosts.
    await db.aiAbilityChoice.create({
      data: {
        organizationId: O,
        ability: 'schema_draft',
        userId: U,
        integrationId: 'aii_air_mine',
        model: 'gpt-p',
      },
    });
    expect(await router.resolve(U, P, O, 'schema_draft')).toMatchObject({
      integrationId: 'aii_air_mine',
      personal: true,
    });
  });
});
