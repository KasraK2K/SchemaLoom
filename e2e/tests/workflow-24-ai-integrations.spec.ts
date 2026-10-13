import { expect, test } from '@playwright/test';
import { FAKE_ANTHROPIC_URL, signedInPage, signIn, write } from '../fixtures/api';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Roadmap 24: an admin adds an OpenAI-compatible integration, grants it, locks the chat
 * ability to it; the analyst's chat reaches the fake, and the lock wins over a personal key.
 * The owner has no grant, so their locked ability resolves to nothing and the panel says so.
 */
test.describe('workflow 24: AI integrations', () => {
  test.skip(
    process.env.CI === undefined && process.env.E2E_FAKE_AI === undefined,
    'needs the fake AI (see workflow 3)',
  );

  test('an admin adds, grants and locks an integration; the lock wins over a personal key', async ({
    browser,
  }) => {
    const admin = await signIn(SEED_EMAILS.admin);
    const owner = await signIn(SEED_EMAILS.owner);
    const analyst = await signIn(SEED_EMAILS.analyst);
    const org = `/api/organizations/${SEED.orgSlug}`;
    const project = SEED.projectId;
    const calls = async (): Promise<{ openai?: boolean }[]> =>
      (await (await fetch(`${FAKE_ANTHROPIC_URL}/calls`)).json()) as { openai?: boolean }[];

    // The server row's `*` grant would serve everyone; take it away for this test, restore after.
    const list = (await (await admin.api.get(`${org}/ai/integrations`)).json()) as {
      id: string;
      source: string;
    }[];
    const server = list.find((i) => i.source === 'server');
    expect(server, 'the server integration row').toBeDefined();
    const serverId = server?.id ?? '';
    const grants = (await (
      await admin.api.get(`${org}/ai/integrations/${serverId}/grants`)
    ).json()) as { id: string; projectId: string | null; userId: string | null }[];
    const everyone = grants.find((g) => g.projectId === null && g.userId === null);
    expect(everyone, 'the server row `*` grant').toBeDefined();
    await admin.api.delete(`${org}/ai/integrations/${serverId}/grants/${everyone?.id ?? ''}`, {
      headers: write(admin),
    });

    let integrationId = '';
    try {
      const created = await admin.api.post(`${org}/ai/integrations`, {
        headers: write(admin),
        data: {
          provider: 'openai_compatible',
          name: 'Fake LLM',
          baseUrl: `${FAKE_ANTHROPIC_URL}/v1`,
          models: ['fake-chat'],
        },
      });
      expect(created.status(), await created.text()).toBe(201);
      integrationId = ((await created.json()) as { id: string }).id;
      const tested = await admin.api.post(`${org}/ai/integrations/${integrationId}/test`, {
        headers: write(admin),
      });
      expect(tested.status(), await tested.text()).toBe(200);
      expect((await tested.json()) as object).toMatchObject({
        status: 'ok',
        fetchedModels: ['fake-chat'],
      });

      // Org admins only see projects they are granted (R13), so the project grant comes from the owner.
      const granted = await owner.api.post(`${org}/ai/integrations/${integrationId}/grants`, {
        headers: write(owner),
        data: { projectId: project, userId: analyst.userId },
      });
      expect(granted.status(), await granted.text()).toBe(201);
      const locked = await admin.api.put(`${org}/ai/choices`, {
        headers: write(admin),
        data: { ability: 'chat', integrationId, model: 'fake-chat', locked: true },
      });
      expect(locked.ok(), await locked.text()).toBe(true);

      // The analyst's chat goes to the fake OpenAI endpoint.
      const thread = (await (
        await analyst.api.post(`/api/projects/${project}/ai/threads`, {
          headers: write(analyst),
          data: {
            title: 'w24',
            selection: {
              entityIds: [SEED.entities.orders],
              fieldIds: [],
              linkIds: [],
              areaIds: [],
            },
          },
        })
      ).json()) as { id: string };
      const before = (await calls()).length;
      const sent = await analyst.api.post(`/api/ai/threads/${thread.id}/messages`, {
        headers: write(analyst),
        data: { content: 'orders over 100', mode: 'query' },
      });
      expect(sent.status(), await sent.text()).toBe(200);
      expect((await calls()).slice(before).some((c) => c.openai === true)).toBe(true);

      // The owner has no grant on it and the server row is ungranted: no model.
      const options = (await (
        await owner.api.get(`/api/projects/${project}/ai/options`)
      ).json()) as { abilities: { id: string; lock: { usable: boolean } | null }[] };
      expect(options.abilities.find((a) => a.id === 'chat')?.lock).toEqual({
        scope: 'org',
        usable: false,
      });
      const page = await signedInPage(browser, SEED_EMAILS.owner);
      await page.goto(`/${SEED.orgSlug}/p/${project}`);
      await page.getByRole('tab', { name: 'AI' }).click();
      await expect(
        page.getByText('Your admin set a model for this that is no longer available.').first(),
      ).toBeVisible();
      await page.context().close();

      // Personal keys allowed; the analyst adds one and picks it, the org lock still wins.
      await admin.api.patch(`${org}/settings`, {
        headers: write(admin),
        data: { ai: { allowPersonalIntegrations: true, personalProviders: [] } },
      });
      const mine = (await (
        await analyst.api.post('/api/me/ai/integrations', {
          headers: write(analyst),
          data: { provider: 'openai', name: 'Mine', apiKey: 'sk-e2e-mine', models: ['gpt-mine'] },
        })
      ).json()) as { id: string };
      try {
        await analyst.api.put('/api/me/ai/choices', {
          headers: write(analyst),
          data: {
            orgSlug: SEED.orgSlug,
            projectId: project,
            ability: 'chat',
            integrationId: mine.id,
            model: 'gpt-mine',
          },
        });
        const after = (await (
          await analyst.api.get(`/api/projects/${project}/ai/options`)
        ).json()) as {
          abilities: { id: string; resolved: { integrationId: string; step: string } | null }[];
        };
        expect(after.abilities.find((a) => a.id === 'chat')?.resolved).toMatchObject({
          integrationId,
          step: 'org_lock',
        });
      } finally {
        await analyst.api.delete(`/api/me/ai/integrations/${mine.id}`, {
          headers: write(analyst),
        });
      }
    } finally {
      await admin.api.patch(`${org}/settings`, {
        headers: write(admin),
        data: { ai: { allowPersonalIntegrations: false, personalProviders: [] } },
      });
      await admin.api.delete(`${org}/ai/choices?ability=chat`, { headers: write(admin) });
      if (integrationId !== '')
        await admin.api.delete(`${org}/ai/integrations/${integrationId}`, {
          headers: write(admin),
        });
      await admin.api.post(`${org}/ai/integrations/${serverId}/grants`, {
        headers: write(admin),
        data: { projectId: null, userId: null },
      });
    }
  });
});
