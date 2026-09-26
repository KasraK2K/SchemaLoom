import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { clientEnv } from '@/env.client';
import { API_PREFIX, toApiError } from '@/lib/api-client';
import { PATHNAME_HEADER } from '@/middleware';

/**
 * The RSC counterpart to `api-client.ts`.
 *
 * `apiFetch` is a BROWSER fetcher: `credentials: 'include'` makes the browser attach the
 * session cookies, and the CSRF echo is read out of `document.cookie`. Neither exists in a
 * Server Component. An RSC `fetch` carries no ambient cookie jar at all, so every call
 * would go out anonymous and come back 401 — which is why this module forwards the
 * INCOMING request's `cookie` header instead. That is the only difference between the two
 * fetchers, and it is why they are two files rather than one flag.
 *
 * There is no CSRF echo here on purpose: server-side reads are GETs, which the API exempts.
 * A write belongs in a client component going through `apiFetch`, where the token lives.
 *
 * `API_INTERNAL_URL` wins over `NEXT_PUBLIC_API_URL` when set. In production the browser
 * reaches the API on a public hostname while the Next server sits next to it on a private
 * address; without the override the server would take the long way round through the
 * public edge — or fail outright where the private network cannot resolve it.
 */
function apiOrigin(): string {
  return process.env.API_INTERNAL_URL ?? clientEnv.NEXT_PUBLIC_API_URL;
}

export function serverApiUrl(path: string): string {
  const withPrefix = path.startsWith(`${API_PREFIX}/`) ? path : `${API_PREFIX}${path}`;
  return `${apiOrigin()}${withPrefix}`;
}

/**
 * Pure, so a test can assert the cookie really is forwarded without a running server —
 * the assertion that is worth having, because a dropped cookie header does not fail
 * loudly. It renders as a signed-in user being told they belong to no organisations.
 */
export function serverRequest(path: string, cookie: string | null): [string, RequestInit] {
  const requestHeaders: Record<string, string> = { Accept: 'application/json' };
  if (cookie !== null && cookie !== '') requestHeaders.cookie = cookie;
  return [serverApiUrl(path), { headers: requestHeaders, cache: 'no-store' }];
}

/** A GET against the API as the user who made the incoming request. */
export async function serverFetch<T>(path: string): Promise<T> {
  const incoming = await headers();
  const [url, init] = serverRequest(path, incoming.get('cookie'));
  const response = await fetch(url, init).catch((cause: unknown) => {
    // Undici's bare "fetch failed" names neither host nor reason. In dev this is almost
    // always the API still booting while `turbo dev` already serves the web app.
    throw new Error(`API unreachable at ${url}`, { cause });
  });

  // The access token (15 min) expired but `sl_presence` (30 days) did not. An RSC cannot
  // refresh — it cannot set cookies — so hand off to /login, which tries a silent
  // refresh in the browser before showing the form.
  if (response.status === 401) {
    const next = incoming.get(PATHNAME_HEADER) ?? '/';
    redirect(`/login?expired=1&next=${encodeURIComponent(next)}`);
  }
  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, payload);
  return payload as T;
}
