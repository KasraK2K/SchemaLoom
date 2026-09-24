import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  COOKIE_NAMES,
  REFRESH_COOKIE_PATH,
  clearUserSessionCookies,
  cookieOptionsFor,
  setShareSessionCookie,
  setUserSessionCookies,
  type CookiePolicy,
} from './cookies';
import { parseDurationSec } from './duration';

const PROD: CookiePolicy = { secure: true, domain: '.schemaloom.dev' };
const LOCAL: CookiePolicy = { secure: false, domain: undefined };

describe('parseDurationSec', () => {
  it('reads the TTL strings env.ts defaults to', () => {
    expect(parseDurationSec('15m')).toBe(900);
    expect(parseDurationSec('30d')).toBe(2_592_000);
    expect(parseDurationSec(' 45s ')).toBe(45);
    expect(parseDurationSec('2h')).toBe(7200);
  });

  it('throws rather than silently yielding a zero-lifetime cookie', () => {
    for (const bad of ['', '15', 'm', '15 m', '-5m', '15w', '0d', 'Infinity']) {
      expect(() => parseDurationSec(bad)).toThrow(RangeError);
    }
  });
});

describe('cookieOptionsFor', () => {
  it('never puts COOKIE_DOMAIN on sl_access, sl_refresh or sl_session (doc 01 §5.4)', () => {
    for (const name of [COOKIE_NAMES.access, COOKIE_NAMES.refresh, COOKIE_NAMES.session]) {
      expect(cookieOptionsFor(name, PROD, 60)).not.toHaveProperty('domain');
    }
  });

  it('puts COOKIE_DOMAIN on sl_presence and sl_csrf only', () => {
    expect(cookieOptionsFor(COOKIE_NAMES.presence, PROD, 60).domain).toBe('.schemaloom.dev');
    expect(cookieOptionsFor(COOKIE_NAMES.csrf, PROD, 60).domain).toBe('.schemaloom.dev');
  });

  it('omits the domain entirely when COOKIE_DOMAIN is unset', () => {
    expect(cookieOptionsFor(COOKIE_NAMES.csrf, LOCAL, 60)).not.toHaveProperty('domain');
  });

  it('makes sl_csrf the only readable cookie', () => {
    expect(cookieOptionsFor(COOKIE_NAMES.csrf, PROD, 60).httpOnly).toBe(false);
    for (const name of [
      COOKIE_NAMES.access,
      COOKIE_NAMES.refresh,
      COOKIE_NAMES.presence,
      COOKIE_NAMES.session,
    ]) {
      expect(cookieOptionsFor(name, PROD, 60).httpOnly).toBe(true);
    }
  });

  it('scopes only sl_refresh by path; sl_session is Path=/ (doc 05 §7.12)', () => {
    expect(cookieOptionsFor(COOKIE_NAMES.refresh, PROD, 60).path).toBe(REFRESH_COOKIE_PATH);
    expect(cookieOptionsFor(COOKIE_NAMES.session, PROD, 60).path).toBe('/');
    expect(cookieOptionsFor(COOKIE_NAMES.access, PROD, 60).path).toBe('/');
  });

  it('is SameSite=Lax everywhere and Secure with COOKIE_SECURE', () => {
    expect(cookieOptionsFor(COOKIE_NAMES.access, PROD, 60).sameSite).toBe('lax');
    expect(cookieOptionsFor(COOKIE_NAMES.access, PROD, 60).secure).toBe(true);
    expect(cookieOptionsFor(COOKIE_NAMES.access, LOCAL, 60).secure).toBe(false);
  });

  it('takes Max-Age in seconds and hands express milliseconds', () => {
    expect(cookieOptionsFor(COOKIE_NAMES.access, PROD, parseDurationSec('15m')).maxAge).toBe(
      900_000,
    );
  });
});

function fakeResponse() {
  return { cookie: vi.fn(), clearCookie: vi.fn() } as unknown as Response & {
    cookie: ReturnType<typeof vi.fn>;
    clearCookie: ReturnType<typeof vi.fn>;
  };
}

describe('setUserSessionCookies', () => {
  it('writes the four user cookies, presence with no value of consequence', () => {
    const res = fakeResponse();
    setUserSessionCookies(res, PROD, {
      accessToken: 'at',
      refreshToken: 'rt',
      csrfToken: 'ct',
      accessTtlSec: 900,
      refreshTtlSec: 2_592_000,
    });
    const written = new Map<string, unknown>(
      res.cookie.mock.calls.map((c) => [String(c[0]), c[1]]),
    );
    expect([...written.keys()].sort()).toEqual(
      ['sl_access', 'sl_csrf', 'sl_presence', 'sl_refresh'].sort(),
    );
    expect(written.get('sl_presence')).toBe('1');
    expect(written.get('sl_refresh')).toBe('rt');
  });

  it('gives sl_presence and sl_csrf the refresh lifetime, not the access one', () => {
    const res = fakeResponse();
    setUserSessionCookies(res, PROD, {
      accessToken: 'at',
      refreshToken: 'rt',
      csrfToken: 'ct',
      accessTtlSec: 900,
      refreshTtlSec: 2_592_000,
    });
    const byName = new Map(res.cookie.mock.calls.map((c) => [String(c[0]), c[2]]));
    expect(byName.get('sl_presence')).toMatchObject({ maxAge: 2_592_000_000 });
    expect(byName.get('sl_csrf')).toMatchObject({ maxAge: 2_592_000_000 });
    expect(byName.get('sl_access')).toMatchObject({ maxAge: 900_000 });
  });
});

describe('setShareSessionCookie', () => {
  it('is host-only and Path=/ even when COOKIE_DOMAIN is set', () => {
    const res = fakeResponse();
    setShareSessionCookie(res, PROD, 'jwt', 3600);
    const [name, value, options] = res.cookie.mock.calls[0] ?? [];
    expect(name).toBe('sl_session');
    expect(value).toBe('jwt');
    expect(options).not.toHaveProperty('domain');
    expect(options).toMatchObject({ path: '/', httpOnly: true, maxAge: 3_600_000 });
  });
});

describe('clearUserSessionCookies', () => {
  it('clears sl_refresh on its own path, or the cookie survives logout', () => {
    const res = fakeResponse();
    clearUserSessionCookies(res, PROD);
    const byName = new Map(res.clearCookie.mock.calls.map((c) => [String(c[0]), c[1]]));
    expect(byName.get('sl_refresh')).toMatchObject({ path: REFRESH_COOKIE_PATH });
    expect(byName.get('sl_csrf')).toMatchObject({ domain: '.schemaloom.dev' });
    expect(byName.get('sl_refresh')).not.toHaveProperty('maxAge');
  });
});
