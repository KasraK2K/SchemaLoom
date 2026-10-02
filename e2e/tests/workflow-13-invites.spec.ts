import { createHash } from 'node:crypto';
import { expect, request, test } from '@playwright/test';
import { API_URL, signIn, write, type Session } from '../fixtures/api';
import { assertE2eDatabase, executeSql } from '../fixtures/database';
import { SEED, SEED_EMAILS } from '../fixtures/seed-ids';

/**
 * Roadmap 16 (docs/phase16/DESIGN.md): an owner invites someone from Settings → Members,
 * the invitee creates their account from the link (verified, no second email) and joins
 * with the invited role.
 *
 * Runs under either `SIGNUP_MODE`: the invite path works in both, and the closed sign-up
 * page is checked only when the api reports sign-up closed. The real token only ever
 * exists in the email, so the test plants a known one on the row the api created.
 */

const tag = String(Date.now());
const INVITEE = `invitee-${tag}@acme.test`;
const TOKEN = `w13-token-${tag}`;
const db = assertE2eDatabase(process.env.DATABASE_URL_E2E);
const base = `/api/organizations/${SEED.orgSlug}/invitations`;

test.describe('workflow 13 — invite a member, who signs up from the link', () => {
  let olivia: Session;

  test.beforeAll(async () => {
    olivia = await signIn(SEED_EMAILS.owner);
  });

  test('an admin cannot invite an owner; an existing member is not invited twice', async () => {
    const adam = await signIn(SEED_EMAILS.admin);
    const owner = await adam.api.post(base, {
      headers: write(adam),
      data: { email: `boss-${tag}@acme.test`, role: 'owner' },
    });
    expect(owner.status()).toBe(403);

    const twice = await olivia.api.post(base, {
      headers: write(olivia),
      data: { email: SEED_EMAILS.analyst, role: 'member' },
    });
    expect(twice.status()).toBe(409);
  });

  test('owner invites, the invitee signs up from the link and lands in the org', async ({
    page,
  }) => {
    const created = await olivia.api.post(base, {
      headers: write(olivia),
      data: { email: INVITEE, role: 'admin' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const hash = createHash('sha256').update(TOKEN).digest('hex');
    executeSql(db, `UPDATE invitations SET token_hash = '${hash}' WHERE id = '${id}';`);

    // The invite page sends a new person to sign-up with the token, which locks the email.
    await page.goto(`/invite/${TOKEN}`);
    await expect(page.getByRole('heading', { name: /invited to/ })).toBeVisible();
    await expect(page.getByText('with the Admin role')).toBeVisible();
    await page.getByRole('link', { name: 'Create an account' }).click();
    await expect(page.getByLabel('Email')).toHaveValue(INVITEE);
    await expect(page.getByLabel('Email')).toHaveJSProperty('readOnly', true);
    await page.getByLabel('Name', { exact: true }).fill('Ivy Invitee');
    await page.getByLabel('Password').fill('SchemaLoom!demo1');
    await page.getByRole('button', { name: 'Create account' }).click();

    // Back on the invite, signed in and already verified by the token: accept works.
    await page.getByRole('button', { name: 'Accept invitation' }).click();
    await page.waitForURL(`**/${SEED.orgSlug}`);

    const members = (await (
      await olivia.api.get(`/api/organizations/${SEED.orgSlug}/members`)
    ).json()) as {
      email: string;
      role: string;
    }[];
    expect(members.find((m) => m.email === INVITEE)?.role).toBe('admin');
    const pending = (await (await olivia.api.get(base)).json()) as { email: string }[];
    expect(pending.some((p) => p.email === INVITEE)).toBe(false);
  });

  test('a revoked invite link is dead', async () => {
    const created = await olivia.api.post(base, {
      headers: write(olivia),
      data: { email: `revoked-${tag}@acme.test`, role: 'member' },
    });
    const { id } = (await created.json()) as { id: string };
    const token = `${TOKEN}-revoked`;
    const hash = createHash('sha256').update(token).digest('hex');
    executeSql(db, `UPDATE invitations SET token_hash = '${hash}' WHERE id = '${id}';`);

    const revoked = await olivia.api.delete(`${base}/${id}`, { headers: write(olivia) });
    expect(revoked.status()).toBe(204);
    const anon = await request.newContext({ baseURL: API_URL });
    expect((await anon.get(`/api/invitations/${token}`)).status()).toBe(404);
  });

  test('when sign-up is closed, /signup without an invite says so', async ({ page }) => {
    const anon = await request.newContext({ baseURL: API_URL });
    const { open } = (await (await anon.get('/api/auth/signup-policy')).json()) as {
      open: boolean;
    };
    test.skip(open, 'this api runs with SIGNUP_MODE=open');

    const refused = await anon.post('/api/auth/register', {
      data: { email: `stranger-${tag}@acme.test`, password: 'SchemaLoom!demo1', name: 'S' },
    });
    expect(refused.status()).toBe(403);
    await page.goto('/signup');
    await expect(page.getByText('Sign-up is by invitation')).toBeVisible();
  });
});
