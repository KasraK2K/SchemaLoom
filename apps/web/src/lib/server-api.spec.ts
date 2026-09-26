import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_PREFIX } from './api-client';
import { serverApiUrl, serverRequest } from './server-api';

/**
 * The cookie forward is the whole reason this module exists, and dropping it does not
 * fail loudly — it renders as a signed-in user being told they belong to no
 * organisations. So it is asserted directly.
 */
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('serverRequest', () => {
  it('forwards the cookie header it is given', () => {
    const [, init] = serverRequest('/organizations', 'sl_access=tok; sl_presence=1');
    expect(new Headers(init.headers).get('cookie')).toBe('sl_access=tok; sl_presence=1');
  });

  it('omits the header entirely when there is no cookie, rather than sending an empty one', () => {
    expect(new Headers(serverRequest('/organizations', null)[1].headers).get('cookie')).toBeNull();
    expect(new Headers(serverRequest('/organizations', '')[1].headers).get('cookie')).toBeNull();
  });

  it('never caches: a project list is per-user and per-request', () => {
    expect(serverRequest('/organizations', null)[1].cache).toBe('no-store');
  });

  it('sends no CSRF echo — server-side reads are GETs and the API exempts them', () => {
    const [, init] = serverRequest('/organizations', 'sl_csrf=tok-123');
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBeNull();
  });
});

describe('serverApiUrl', () => {
  it('applies the global route prefix once', () => {
    expect(serverApiUrl('/organizations')).toBe(`http://localhost:3001${API_PREFIX}/organizations`);
    expect(serverApiUrl('/api/organizations')).toBe('http://localhost:3001/api/organizations');
  });

  it('prefers API_INTERNAL_URL, so RSC can reach the API on a private address', () => {
    vi.stubEnv('API_INTERNAL_URL', 'http://api.internal:3001');
    expect(serverApiUrl('/organizations')).toBe('http://api.internal:3001/api/organizations');
  });
});
