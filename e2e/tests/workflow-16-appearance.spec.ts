import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { API_URL, signIn, write } from '../fixtures/api';
import { assertE2eDatabase, executeSql } from '../fixtures/database';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

const tag = String(Date.now());
const INVITEE = `look-${tag}@acme.test`;
const TOKEN = `w16-token-${tag}`;
const db = assertE2eDatabase(process.env.DATABASE_URL_E2E);

/**
 * Appearance themes: the choice is applied before paint, saved to the account, and follows
 * the user to a browser that has never seen it. Restores the default at the end, so later
 * runs start from Studio.
 */
test.describe('workflow 16 — appearance themes', () => {
  test('pick Blueprint in Olive, see it applied, and find it on another device', async ({
    browser,
  }) => {
    const session = await signIn(SEED_EMAILS.owner);
    const state = await session.api.storageState();
    try {
      const context = await browser.newContext({ storageState: state });
      const page = await context.newPage();
      await page.goto(`/${SEED.orgSlug}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'studio');

      // The top bar's appearance button (the mode icon) opens the panel.
      await page.getByRole('button', { name: 'Appearance' }).click();
      const html = page.locator('html');

      // Pointing at a theme changes nothing; a click picks, with no Apply step.
      await page.getByRole('radio', { name: 'Float' }).hover();
      await expect(html).toHaveAttribute('data-theme', 'studio');
      await page.getByRole('radio', { name: 'Blueprint' }).click();
      await page.getByRole('radio', { name: 'Olive' }).click();
      await page.getByRole('radio', { name: 'Dark' }).click();
      await page.getByRole('button', { name: 'Done' }).click();

      await expect(html).toHaveAttribute('data-theme', 'blueprint');
      await expect(html).toHaveAttribute('data-variant', 'olive');
      await expect(html).toHaveClass(/dark/);
      // The theme changes more than colour: Blueprint's corners are sharp.
      await expect(page.getByRole('link', { name: 'Settings' })).toHaveCSS(
        'border-top-left-radius',
        '0px',
      );

      // Saved to the account, not only to this browser.
      await expect
        .poll(async () => {
          const me = (await (await session.api.get(`${API_URL}/api/auth/me`)).json()) as {
            appearance: unknown;
          };
          return me.appearance;
        })
        .toEqual({ theme: 'blueprint', variant: 'olive', mode: 'dark' });
      await context.close();

      // A fresh browser (no stored choice) adopts the account's.
      const other = await browser.newContext({ storageState: state });
      const page2 = await other.newPage();
      await page2.goto(`/${SEED.orgSlug}`);
      await expect(page2.locator('html')).toHaveAttribute('data-theme', 'blueprint');
      await expect(page2.locator('html')).toHaveAttribute('data-variant', 'olive');
      await other.close();
    } finally {
      const reset = await session.api.put(`${API_URL}/api/auth/me/appearance`, {
        headers: write(session),
        data: { theme: 'studio', variant: 'jade', mode: 'system' },
      });
      expect(reset.status()).toBe(200);
    }
  });

  test("refuses a variant that is not the theme's own", async () => {
    const session = await signIn(SEED_EMAILS.owner);
    const response = await session.api.put(`${API_URL}/api/auth/me/appearance`, {
      headers: write(session),
      data: { theme: 'blueprint', variant: 'jade', mode: 'dark' },
    });
    expect(response.status()).toBe(400);
  });

  // docs/phase17/ORG-DEFAULT.md: the org's default look reaches a new account, not old ones.
  test('an owner sets the org default; an invited sign-up starts on it', async ({
    browser,
    page,
  }) => {
    const olivia = await signIn(SEED_EMAILS.owner);
    const settings = `${API_URL}/api/organizations/${SEED.orgSlug}/settings`;
    const patch = (data: object) => olivia.api.patch(settings, { headers: write(olivia), data });
    try {
      // Owner: Settings → General → Blueprint Graphite → Save.
      const state = await olivia.api.storageState();
      const ownerContext = await browser.newContext({ storageState: state });
      const ownerPage = await ownerContext.newPage();
      await ownerPage.goto(`/${SEED.orgSlug}/settings/general`);
      await ownerPage.getByRole('radio', { name: 'Blueprint' }).click();
      await ownerPage.getByRole('radio', { name: 'Graphite' }).click();
      await ownerPage.getByRole('button', { name: 'Save' }).click();
      await expect(ownerPage.getByRole('status')).toHaveText('Saved');
      expect(await (await olivia.api.get(settings)).json()).toMatchObject({
        defaultAppearance: { theme: 'blueprint', variant: 'graphite', mode: 'system' },
      });
      // A default, not an overwrite: the owner's own look is untouched.
      await expect(ownerPage.locator('html')).toHaveAttribute('data-theme', 'studio');
      await ownerContext.close();

      // Invite, plant a known token (the real one only exists in the email), sign up.
      const created = await olivia.api.post(
        `${API_URL}/api/organizations/${SEED.orgSlug}/invitations`,
        { headers: write(olivia), data: { email: INVITEE, role: 'member' } },
      );
      expect(created.status(), await created.text()).toBe(201);
      const { id } = (await created.json()) as { id: string };
      const hash = createHash('sha256').update(TOKEN).digest('hex');
      executeSql(db, `UPDATE invitations SET token_hash = '${hash}' WHERE id = '${id}';`);

      await page.goto(`/invite/${TOKEN}`);
      await page.getByRole('link', { name: 'Create an account' }).click();
      await page.getByLabel('Name', { exact: true }).fill('Lou Look');
      await page.getByLabel('Password').fill('SchemaLoom!demo1');
      await page.getByRole('button', { name: 'Create account' }).click();

      // The first page after sign-up is already in the org's look.
      await expect(page.getByRole('button', { name: 'Accept invitation' })).toBeVisible();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'blueprint');
      await expect(page.locator('html')).toHaveAttribute('data-variant', 'graphite');
      const me = (await (await page.request.get(`${API_URL}/api/auth/me`)).json()) as {
        appearance: unknown;
      };
      expect(me.appearance).toEqual({ theme: 'blueprint', variant: 'graphite', mode: 'system' });

      await page.getByRole('button', { name: 'Accept invitation' }).click();
      await page.waitForURL(`**/${SEED.orgSlug}`);
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'blueprint');
    } finally {
      expect((await patch({ defaultAppearance: null })).status()).toBe(200);
    }
  });

  test('a plain member cannot read or change the org default', async () => {
    const analyst = await signIn(SEED_EMAILS.analyst);
    const settings = `${API_URL}/api/organizations/${SEED.orgSlug}/settings`;
    expect((await analyst.api.get(settings)).status()).toBe(404);
    const patched = await analyst.api.patch(settings, {
      headers: write(analyst),
      data: { defaultAppearance: null },
    });
    expect(patched.status()).toBe(404);
  });
});
