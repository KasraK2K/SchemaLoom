import { z } from 'zod';
import { clientEnv } from '@/env.client';

/**
 * The browser talks to the API directly — no Next rewrite proxy, no route handlers
 * (doc 01 §5.4). That makes two things this module's responsibility:
 *
 *  1. `credentials: 'include'`, or none of the session cookies are sent and every
 *     request is anonymous.
 *  2. The CSRF double-submit echo. `sl_csrf` is deliberately NOT httpOnly precisely so
 *     this file can read it and mirror it into `X-CSRF-Token`. The API rejects any
 *     unsafe request whose header does not match the cookie with a 403, so without
 *     this echo nothing in the app can write.
 */
/**
 * Every API route lives under this prefix — `main.ts` does
 * `setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] })`.
 *
 * It is applied HERE, once, rather than written into each call site. It was written into
 * call sites, and the two halves of the app disagreed: the auth forms sent
 * `/api/auth/login` and the canvas sent `/projects/:id/ir`, so the canvas 404'd against
 * a perfectly healthy API. Nothing caught it because no unit test builds a real URL —
 * they all mock `apiFetch` itself.
 *
 * Callers pass the route WITHOUT the prefix: `/projects/:id/ir`, `/auth/login`.
 */
export const API_PREFIX = '/api';

export const CSRF_COOKIE = 'sl_csrf';
export const CSRF_HEADER = 'X-CSRF-Token';

/** Methods the API demands a CSRF echo for. GET/HEAD/OPTIONS are exempt. */
const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  for (const part of document.cookie.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

/** The API's error envelope. Parsed rather than trusted — it is a network payload. */
const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiRequestInit extends Omit<RequestInit, 'body'> {
  /** Serialised as JSON. Pass a `BodyInit` through `fetch` directly if you need one. */
  body?: unknown;
  /** Sent as-is as `text/plain` instead of `body` — the large SQL import takes raw text. */
  text?: string;
}

/**
 * Absolute URL for an API route. Exported so a test can assert the shape without a
 * network, which is the assertion that was missing when the prefix drifted.
 */
export function apiUrl(path: string): string {
  const withPrefix = path.startsWith(`${API_PREFIX}/`) ? path : `${API_PREFIX}${path}`;
  return `${clientEnv.NEXT_PUBLIC_API_URL}${withPrefix}`;
}

/** Routes that must never trigger a refresh attempt — refreshing them is circular. */
const NO_REFRESH = new Set([
  '/auth/refresh',
  '/auth/login',
  '/auth/register',
  '/auth/logout',
  '/auth/magic-link/consume',
  // A 401 here is an expired 2FA challenge, not an expired session. Refreshing would
  // bounce the visitor to /login?expired=1 with a misleading message.
  '/auth/2fa/verify',
]);

/**
 * In flight refresh, shared by every caller.
 *
 * Loading a project fires several requests at once. If the access token has expired they
 * ALL come back 401 together, and a refresh per request would rotate the refresh token N
 * times concurrently — which the API correctly treats as token REUSE and answers by
 * revoking the whole family. The user would be hard-signed-out by their own page load.
 * One shared promise, so N failures cause exactly one rotation.
 */
let refreshInFlight: Promise<boolean> | null = null;

function refreshSession(): Promise<boolean> {
  refreshInFlight ??= (async () => {
    try {
      const headers = new Headers({ Accept: 'application/json' });
      const csrfToken = readCookie(CSRF_COOKIE);
      if (csrfToken !== undefined) headers.set(CSRF_HEADER, csrfToken);
      const response = await fetch(apiUrl('/auth/refresh'), {
        method: 'POST',
        headers,
        credentials: 'include',
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      // Cleared synchronously. Every concurrent caller already holds a reference to THIS
      // promise, so nulling the variable cannot affect them — it only decides whether a
      // LATER 401 starts a new attempt, which is exactly what should happen. Deferring
      // the clear (an earlier version used setTimeout) leaves a resolved promise in
      // place across the tick boundary, so the next expiry silently reuses a stale
      // result instead of refreshing.
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

/**
 * The session is unrecoverable: the refresh token is gone, expired, or was revoked.
 *
 * This has to actively send the browser to /login, because `sl_presence` (30 days)
 * outlives `sl_access` (15 minutes). Without it the middleware still believes the user
 * is signed in, bounces them off /login, and every request 401s — a dead session with no
 * route out of it through the UI. `?expired=1` lets the page say why.
 */
function abandonSession(): void {
  if (typeof window === 'undefined') return;
  // A share-link visitor has no account to sign in to. Their `sl_session` lasts at most
  // 12 hours; the way back is the link's own unlock page, which mints a fresh one.
  const share = /^\/s\/([^/]+)/.exec(window.location.pathname);
  if (share !== null) {
    window.location.assign(`/s/${share[1] ?? ''}`);
    return;
  }
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.assign(`/login?expired=1&next=${encodeURIComponent(next)}`);
}

async function send(path: string, init: ApiRequestInit): Promise<Response> {
  const { body, text, headers, method = 'GET', ...rest } = init;
  const upperMethod = method.toUpperCase();

  const requestHeaders = new Headers(headers);
  requestHeaders.set('Accept', 'application/json');
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  if (text !== undefined) requestHeaders.set('Content-Type', 'text/plain; charset=utf-8');

  if (UNSAFE_METHODS.has(upperMethod)) {
    // Re-read per attempt: a refresh rotates sl_csrf, so the retry must not reuse the
    // token that was read before the refresh.
    const csrfToken = readCookie(CSRF_COOKIE);
    if (csrfToken !== undefined) requestHeaders.set(CSRF_HEADER, csrfToken);
  }

  return fetch(apiUrl(path), {
    ...rest,
    method: upperMethod,
    headers: requestHeaders,
    credentials: 'include',
    body: text ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

export async function apiFetch<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  let response = await send(path, init);

  // A short-lived access token expiring mid-session is the NORMAL case, not an error:
  // the design pairs a 15-minute access token with a 30-day rotating refresh token, and
  // nothing was spending the refresh token. Do it here, once, so no caller has to.
  if (response.status === 401 && !NO_REFRESH.has(path)) {
    if (await refreshSession()) {
      response = await send(path, init);
    } else {
      abandonSession();
    }
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw toApiError(response.status, payload);
  return payload as T;
}

export function toApiError(status: number, payload: unknown): ApiError {
  const parsed = ErrorEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    return new ApiError(status, 'unknown', `Request failed with status ${String(status)}`);
  }
  const { code, message, details } = parsed.data.error;
  return new ApiError(status, code, message, details);
}
