import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signedInPage, signIn, write, type Session } from '../fixtures/api';
import { fetchIr } from '../fixtures/ir';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Doc 04 §8.7 — realtime. The owner edits through the API; the analyst's open canvas
 * shows the change through `schema:patch` without a reload.
 *
 * Runs after workflows 1-6 (the name) and renames `customers` back in `finally`, because
 * the other workflows assert on the seed's names.
 */
const P = SEED.projectId;
const CUSTOMERS = SEED.entities.customers;

const rename = async (owner: Session, name: string): Promise<void> => {
  const version = (await fetchIr(owner, P)).objects.entity[CUSTOMERS]?.version ?? 0;
  const response = await owner.api.post(`/api/projects/${P}/schema/ops`, {
    headers: write(owner),
    data: {
      batchId: randomUUID(),
      projectId: P,
      ops: [{ op: 'update', type: 'entity', id: CUSTOMERS, expectedVersion: version, patch: { name } }],
    },
  });
  expect(response.status(), await response.text()).toBe(201);
};

test.describe('workflow 7 — realtime', () => {
  test('a second user sees the owner’s rename without reloading', async ({ browser }) => {
    const owner = await signIn(SEED_EMAILS.owner);
    const page = await signedInPage(browser, SEED_EMAILS.analyst);
    await page.goto(`/${SEED.orgSlug}/p/${P}`);
    await expect(page.getByText('customers').first()).toBeVisible({ timeout: 30_000 });
    // Survives only if the page is never reloaded.
    await page.evaluate(() => {
      (globalThis as unknown as { __noReload: boolean }).__noReload = true;
    });

    try {
      await rename(owner, 'clients_live');
      await expect(page.getByText('clients_live').first()).toBeVisible({ timeout: 15_000 });
      expect(await page.evaluate(() => (globalThis as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
    } finally {
      await rename(owner, 'customers');
    }
    await expect(page.getByText('customers').first()).toBeVisible({ timeout: 15_000 });
  });
});
