import {
  expect,
  request,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';
import { createHmac } from 'node:crypto';
import { API_URL, signIn, write } from '../fixtures/api';

/**
 * Roadmap 15 (built in Phase 3, `267445f`), covered by `docs/phase20/DESIGN.md` §4: the sign-in
 * link, TOTP two-factor with recovery codes, and signing other devices out. Each test signs up
 * its own account, so nothing here touches the seed users. Google and GitHub stay unit-tested.
 *
 * The sign-in link is read from Mailpit (`pnpm infra:up`); the e2e api blanks MAILGUN_* so mail
 * goes there. Without Mailpit that test skips.
 */

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';
const PASSWORD = 'SchemaLoom!demo1';

async function newAccount(api: APIRequestContext, tag: string): Promise<string> {
  const policy = (await (await api.get(`${API_URL}/api/auth/signup-policy`)).json()) as {
    open: boolean;
  };
  test.skip(!policy.open, 'sign-up is closed on this api (SIGNUP_MODE=invite)');
  const email = `w19-${tag}-${String(Date.now())}@acme.test`;
  const created = await api.post(`${API_URL}/api/auth/register`, {
    data: { email, password: PASSWORD, name: `W19 ${tag}` },
  });
  expect(created.status(), await created.text()).toBe(201);
  return email;
}

/** RFC 6238 over the base32 secret the enrol step shows; `ahead` steps into the future. */
function totp(secret: string, ahead = 0): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret.replace(/=+$/, '').toUpperCase())
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + ahead));
  const mac = createHmac('sha1', key).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0xf;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}

/** A click before React hydrates does nothing (or submits the form natively), so wait. */
async function openLogin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
}

/** The browser's sign-in form; resolves once the page has moved on from /login. */
async function signInInBrowser(browser: Browser, email: string) {
  const page = await (await browser.newContext()).newPage();
  await openLogin(page);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname !== '/login');
  return page;
}

test.describe('workflow 19 — sign-in link, two-factor, devices', () => {
  test('a sign-in link from the email signs in once', async ({ browser }) => {
    const mailpit = await request.newContext();
    const reachable = await mailpit
      .get(`${MAILPIT}/api/v1/messages?limit=1`)
      .then((r) => r.ok())
      .catch(() => false);
    test.skip(!reachable, `Mailpit is not reachable at ${MAILPIT}`);
    const email = await newAccount(mailpit, 'link');

    const page = await (await browser.newContext()).newPage();
    await openLogin(page);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
    await expect(page.getByRole('status')).toContainText('a link is on its way');

    let link = '';
    await expect
      .poll(
        async () => {
          const found = (await (
            await mailpit.get(`${MAILPIT}/api/v1/search`, { params: { query: `to:"${email}"` } })
          ).json()) as { messages: { ID: string; Subject: string }[] };
          const message = found.messages.find((m) => m.Subject.includes('sign-in link'));
          if (message === undefined) return '';
          const body = (await (
            await mailpit.get(`${MAILPIT}/api/v1/message/${message.ID}`)
          ).json()) as { Text: string };
          link = /https?:\/\/\S+\/magic-link\?\S+/.exec(body.Text)?.[0] ?? '';
          return link;
        },
        { timeout: 30_000 },
      )
      .not.toBe('');

    await page.goto(link);
    await page.waitForURL((url) => !['/magic-link', '/login'].includes(url.pathname));
    const me = await page.request.get(`${API_URL}/api/auth/me`);
    expect(((await me.json()) as { email: string }).email).toBe(email);

    // The same link again: spent.
    const token = new URL(link).searchParams.get('token') ?? '';
    const again = await mailpit.post(`${API_URL}/api/auth/magic-link/consume`, {
      data: { token },
    });
    expect(again.status()).toBeGreaterThanOrEqual(400);
  });

  test('two-factor: turn on, sign in with a code, then a recovery code works once', async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const email = await newAccount(await request.newContext(), 'totp');

    const settings = await signInInBrowser(browser, email);
    await settings.goto('/settings/security');
    await settings.waitForLoadState('networkidle');
    await settings.getByRole('button', { name: 'Set up two-factor' }).click();
    const key = settings.locator('code', { hasText: /^[A-Z2-7]{16,}$/ });
    await expect(key).toBeVisible();
    const secret = (await key.textContent())?.trim() ?? '';
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    await settings.getByLabel('Code', { exact: true }).fill(totp(secret));
    await settings.getByRole('button', { name: 'Turn on' }).click();
    const codes = settings.locator('ul.font-mono li');
    await expect(codes.first()).toBeVisible();
    const recovery = (await codes.allTextContents()).map((c) => c.trim());
    expect(recovery.length).toBeGreaterThan(0);
    await settings.getByRole('button', { name: 'I have saved them' }).click();
    await expect(settings.getByText('On. Signing in asks for a code')).toBeVisible();

    // The password alone now stops at the challenge. The next step's code, so it can't be the
    // one just spent on "Turn on" (codes are single-use within their window).
    const withCode = await signInInBrowser(browser, email);
    await expect(withCode).toHaveURL(/\/two-factor/);
    await withCode.getByLabel('Code', { exact: true }).fill(totp(secret, 1));
    await withCode.getByRole('button', { name: 'Verify' }).click();
    await withCode.waitForURL((url) => url.pathname !== '/two-factor');

    const [first] = recovery;
    const withRecovery = await signInInBrowser(browser, email);
    await withRecovery.getByLabel('Code', { exact: true }).fill(first ?? '');
    await withRecovery.getByRole('button', { name: 'Verify' }).click();
    await withRecovery.waitForURL((url) => url.pathname !== '/two-factor');

    const reused = await signInInBrowser(browser, email);
    await reused.getByLabel('Code', { exact: true }).fill(first ?? '');
    await reused.getByRole('button', { name: 'Verify' }).click();
    await expect(reused.getByRole('alert')).toBeVisible();
    await expect(reused).toHaveURL(/\/two-factor/);
  });

  test('signing out other devices ends their sessions', async () => {
    const email = await newAccount(await request.newContext(), 'devices');
    const here = await signIn(email, PASSWORD);
    const there = await signIn(email, PASSWORD);

    const before = (await (await here.api.get('/api/auth/sessions')).json()) as {
      sessions: { current: boolean }[];
    };
    // Registering opened a session too, so at least these two.
    expect(before.sessions.length).toBeGreaterThanOrEqual(2);

    const revoked = await here.api.post('/api/auth/sessions/revoke-others', {
      headers: write(here),
    });
    expect(revoked.status()).toBe(204);

    // The other device's refresh token is dead; its access token simply runs out.
    const refresh = await there.api.post('/api/auth/refresh', { headers: write(there) });
    expect(refresh.status()).toBe(401);

    const after = (await (await here.api.get('/api/auth/sessions')).json()) as {
      sessions: { current: boolean }[];
    };
    expect(after.sessions).toEqual([expect.objectContaining({ current: true })]);
  });
});
