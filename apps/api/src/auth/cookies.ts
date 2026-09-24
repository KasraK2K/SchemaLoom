import type { ConfigService } from '@nestjs/config';
import type { CookieOptions, Response } from 'express';
import type { AppEnv } from '../config/env';

/**
 * Doc 01 §5.4 — the cookie inventory. One table, one file, no second opinion.
 *
 * | Cookie        | Domain             | httpOnly | Path        | Lifetime            |
 * |---------------|--------------------|----------|-------------|---------------------|
 * | `sl_access`   | host-only          | yes      | `/`         | ACCESS_TOKEN_TTL    |
 * | `sl_refresh`  | host-only          | yes      | `/api/auth` | REFRESH_TOKEN_TTL   |
 * | `sl_presence` | `${COOKIE_DOMAIN}` | yes      | `/`         | = `sl_refresh`      |
 * | `sl_csrf`     | `${COOKIE_DOMAIN}` | **no**   | `/`         | = `sl_refresh`      |
 * | `sl_session`  | host-only          | yes      | `/`         | min(expiresAt, 12h) |
 *
 * `COOKIE_DOMAIN` is applied to `sl_presence` and `sl_csrf` ONLY. Giving it to
 * `sl_access`/`sl_refresh` hands a refresh token to every subdomain of
 * `schemaloom.dev` — one XSS on a future marketing or status host is then a full
 * account takeover. `sl_session` is host-only for the same reason.
 */
export const COOKIE_NAMES = {
  access: 'sl_access',
  refresh: 'sl_refresh',
  presence: 'sl_presence',
  csrf: 'sl_csrf',
  session: 'sl_session',
} as const;

export type CookieName = (typeof COOKIE_NAMES)[keyof typeof COOKIE_NAMES];

/** The three cookies that carry authority. Their presence is what the CSRF middleware keys on. */
export const AUTHORITY_COOKIES: readonly CookieName[] = [
  COOKIE_NAMES.access,
  COOKIE_NAMES.refresh,
  COOKIE_NAMES.session,
];

/**
 * Doc 01 §5.4 writes this as `Path=/auth`. `main.ts` sets a global prefix of `api`, so
 * the refresh route's real URL is `/api/auth/refresh` and a `/auth`-scoped cookie is
 * never sent to it — every refresh would 401 an hour into the first session. The path
 * that matters is the one the browser matches, so it is the prefixed one.
 */
export const REFRESH_COOKIE_PATH = '/api/auth';

/** `sl_presence` "has no value of consequence — it is `1`" (§5.4). */
export const PRESENCE_COOKIE_VALUE = '1';

export interface CookiePolicy {
  /** `COOKIE_SECURE`. */
  readonly secure: boolean;
  /** `COOKIE_DOMAIN`, or undefined locally. Never reaches a host-only cookie. */
  readonly domain: string | undefined;
}

/** The only place `COOKIE_SECURE` / `COOKIE_DOMAIN` are read. */
export function cookiePolicyFrom(config: ConfigService<AppEnv, true>): CookiePolicy {
  return {
    secure: config.get('COOKIE_SECURE', { infer: true }),
    domain: config.get('COOKIE_DOMAIN', { infer: true }),
  };
}

/**
 * The single place a cookie's attributes are decided. Everything is `SameSite=Lax`
 * (§5.4) and `Secure` under `COOKIE_SECURE`.
 *
 * @param maxAgeSec omit for a session cookie; pass 0 to expire one.
 */
export function cookieOptionsFor(
  name: CookieName,
  policy: CookiePolicy,
  maxAgeSec: number,
): CookieOptions {
  const scoped = name === COOKIE_NAMES.presence || name === COOKIE_NAMES.csrf;
  return {
    httpOnly: name !== COOKIE_NAMES.csrf,
    secure: policy.secure,
    sameSite: 'lax',
    path: name === COOKIE_NAMES.refresh ? REFRESH_COOKIE_PATH : '/',
    ...(scoped && policy.domain ? { domain: policy.domain } : {}),
    maxAge: maxAgeSec * 1000,
  };
}

export interface UserSessionCookies {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly csrfToken: string;
  readonly accessTtlSec: number;
  readonly refreshTtlSec: number;
}

/** Login, registration, refresh and the OAuth callback all end here. */
export function setUserSessionCookies(
  res: Response,
  policy: CookiePolicy,
  c: UserSessionCookies,
): void {
  res.cookie(COOKIE_NAMES.access, c.accessToken, {
    ...cookieOptionsFor(COOKIE_NAMES.access, policy, c.accessTtlSec),
  });
  res.cookie(COOKIE_NAMES.refresh, c.refreshToken, {
    ...cookieOptionsFor(COOKIE_NAMES.refresh, policy, c.refreshTtlSec),
  });
  res.cookie(COOKIE_NAMES.presence, PRESENCE_COOKIE_VALUE, {
    ...cookieOptionsFor(COOKIE_NAMES.presence, policy, c.refreshTtlSec),
  });
  res.cookie(COOKIE_NAMES.csrf, c.csrfToken, {
    ...cookieOptionsFor(COOKIE_NAMES.csrf, policy, c.refreshTtlSec),
  });
}

/** The share-link visitor cookie (doc 05 §7.12). Stateless — there is no `sessions` row. */
export function setShareSessionCookie(
  res: Response,
  policy: CookiePolicy,
  token: string,
  ttlSec: number,
): void {
  res.cookie(COOKIE_NAMES.session, token, {
    ...cookieOptionsFor(COOKIE_NAMES.session, policy, ttlSec),
  });
}

/**
 * `clearCookie` only matches when path and domain match the cookie that was set, so
 * this reuses `cookieOptionsFor` rather than restating them — the classic logout bug
 * is a cleared `Path=/` cookie leaving the `Path=/api/auth` refresh token alive.
 */
export function clearUserSessionCookies(res: Response, policy: CookiePolicy): void {
  for (const name of [
    COOKIE_NAMES.access,
    COOKIE_NAMES.refresh,
    COOKIE_NAMES.presence,
    COOKIE_NAMES.csrf,
  ] as const) {
    const { maxAge: _maxAge, ...options } = cookieOptionsFor(name, policy, 0);
    res.clearCookie(name, options);
  }
}
