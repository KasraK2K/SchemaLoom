import { expect, request, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { DEMO_PASSWORD } from './seed-ids';

/**
 * Signing in, twice over.
 *
 * The web app's sign-in form is not built yet (`apps/web/src/app/(auth)/login/page.tsx`
 * is a placeholder), so the browser half of these specs authenticates by posting to the
 * API and handing the resulting cookies to a browser context. That is the normal
 * Playwright pattern anyway — driving a login form once per test is slow and tests the
 * form, not the thing under test — and it means these specs do not have to be rewritten
 * when the form lands.
 *
 * The API half keeps its own `APIRequestContext`, because the assertions that matter for
 * permissions are STATUS CODES (403 on edit, 404 on a resource you may not know exists)
 * and a UI that renders "something went wrong" cannot tell those apart.
 */

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001';

export interface Session {
  readonly api: APIRequestContext;
  /** Echo on every mutating request as `X-CSRF-Token`; the middleware keys on the cookie. */
  readonly csrfToken: string;
  readonly userId: string;
}

/** Authenticate against the real API. The returned context carries the session cookies. */
export async function signIn(email: string, password = DEMO_PASSWORD): Promise<Session> {
  const api = await request.newContext({ baseURL: API_URL });
  const response = await api.post('/api/auth/login', { data: { email, password } });
  expect(response.status(), `login failed for ${email}: ${await response.text()}`).toBe(200);

  const body = (await response.json()) as { csrfToken: string; user: { id: string } };
  return { api, csrfToken: body.csrfToken, userId: body.user.id };
}

/** Headers for any POST/PATCH/DELETE through a signed-in `Session`. */
export const write = (session: Session): Record<string, string> => ({
  'x-csrf-token': session.csrfToken,
  'content-type': 'application/json',
});

/**
 * A browser page already signed in as `email`, by lifting the API session's cookies into
 * a fresh browser context. Cookies come back host-scoped for the API origin; the web app
 * and the api share `localhost`, so they are sent on both.
 */
export async function signedInPage(browser: Browser, email: string): Promise<Page> {
  const session = await signIn(email);
  const state = await session.api.storageState();
  const context = await browser.newContext({ storageState: state });
  return context.newPage();
}
