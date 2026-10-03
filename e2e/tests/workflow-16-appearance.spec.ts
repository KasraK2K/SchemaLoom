import { expect, test } from '@playwright/test';
import { API_URL, signIn, write } from '../fixtures/api';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

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

      await page.getByRole('button', { name: 'Account' }).click();
      await page.getByRole('menuitem', { name: 'Appearance…' }).click();
      await page.getByRole('radio', { name: 'Blueprint' }).click();
      await page.getByRole('radio', { name: 'Olive' }).click();
      await page.getByRole('radio', { name: 'Dark' }).click();
      await page.getByRole('button', { name: 'Apply' }).click();

      const html = page.locator('html');
      await expect(html).toHaveAttribute('data-theme', 'blueprint');
      await expect(html).toHaveAttribute('data-variant', 'olive');
      await expect(html).toHaveClass(/dark/);
      // The theme changes more than colour: Blueprint's corners are sharp.
      await expect(page.getByRole('link', { name: 'Settings' })).toHaveCSS(
        'border-top-left-radius',
        '2px',
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
});
