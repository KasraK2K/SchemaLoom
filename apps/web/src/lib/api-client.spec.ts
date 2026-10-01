import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  API_PREFIX,
  ApiError,
  apiFetch,
  apiUrl,
  CSRF_HEADER,
  readCookie,
  toApiError,
} from './api-client';

const fetchMock = vi.fn<typeof fetch>();

/**
 * A Response body is a stream and can be read once. Every mock here therefore returns
 * a FRESH Response per call — `mockResolvedValue(new Response(...))` hands the same
 * consumed body to the second call and the test silently exercises the parse-failure
 * path instead of the one it names.
 */
function respondWith(body: unknown, status = 200): void {
  fetchMock.mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  );
}

function lastRequestInit(): RequestInit {
  const call = fetchMock.mock.calls.at(-1);
  expect(call).toBeDefined();
  return call![1]!;
}

function headerOf(name: string): string | null {
  return new Headers(lastRequestInit().headers).get(name);
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('document', { cookie: 'sl_presence=1; sl_csrf=tok-123; other=x' });
  respondWith({ ok: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe('readCookie', () => {
  it('finds a cookie by exact name among others', () => {
    expect(readCookie('sl_csrf')).toBe('tok-123');
    expect(readCookie('sl_presence')).toBe('1');
  });

  it('does not match a name that is only a suffix or prefix', () => {
    expect(readCookie('csrf')).toBeUndefined();
    expect(readCookie('sl_csrf_extra')).toBeUndefined();
  });

  it('returns undefined on the server, where there is no document', () => {
    vi.stubGlobal('document', undefined);
    expect(readCookie('sl_csrf')).toBeUndefined();
  });
});

describe('apiFetch CSRF echo', () => {
  it.each(['POST', 'PATCH', 'DELETE', 'PUT'])('sends %s with X-CSRF-Token', async (method) => {
    await apiFetch('/projects', { method });
    expect(headerOf(CSRF_HEADER)).toBe('tok-123');
  });

  it('does not send X-CSRF-Token on a GET', async () => {
    await apiFetch('/projects');
    expect(headerOf(CSRF_HEADER)).toBeNull();
  });

  it('does not send X-CSRF-Token on a HEAD', async () => {
    await apiFetch('/projects', { method: 'HEAD' });
    expect(headerOf(CSRF_HEADER)).toBeNull();
  });

  it('omits the header when the cookie is absent rather than sending an empty one', async () => {
    vi.stubGlobal('document', { cookie: 'sl_presence=1' });
    await apiFetch('/projects', { method: 'POST' });
    expect(headerOf(CSRF_HEADER)).toBeNull();
  });

  it('treats a lowercase method as unsafe too', async () => {
    await apiFetch('/projects', { method: 'post' });
    expect(headerOf(CSRF_HEADER)).toBe('tok-123');
  });
});

describe('apiFetch request shape', () => {
  it('always sends credentials so the session cookies travel', async () => {
    await apiFetch('/me');
    expect(lastRequestInit().credentials).toBe('include');

    await apiFetch('/me', { method: 'POST' });
    expect(lastRequestInit().credentials).toBe('include');
  });

  it('prefixes the configured API origin AND the global route prefix', async () => {
    // This assertion used to read `http://localhost:3001/me`, which passed while being
    // wrong: the API mounts everything under `/api`, so a prefixless URL 404s. The
    // canvas shipped exactly that and the test agreed with it. A URL assertion is only
    // worth having if it encodes the route the server actually serves.
    await apiFetch('/me');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://localhost:3001/api/me');
  });

  it('serialises the body as JSON and sets the content type', async () => {
    await apiFetch('/projects', { method: 'POST', body: { name: 'billing' } });
    expect(lastRequestInit().body).toBe('{"name":"billing"}');
    expect(headerOf('Content-Type')).toBe('application/json');
  });

  it('sends no content type when there is no body', async () => {
    await apiFetch('/me');
    expect(headerOf('Content-Type')).toBeNull();
  });
});

describe('apiFetch responses', () => {
  it('returns the parsed body', async () => {
    respondWith({ id: 'p1' });
    await expect(apiFetch<{ id: string }>('/projects/p1')).resolves.toEqual({ id: 'p1' });
  });

  it('returns undefined for 204 without trying to parse a body', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    await expect(apiFetch('/projects/p1', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('throws a typed ApiError from the error envelope', async () => {
    respondWith({ error: { code: 'forbidden', message: 'Missing CSRF token' } }, 403);
    await expect(apiFetch('/projects', { method: 'POST' })).rejects.toThrow(ApiError);
    await expect(apiFetch('/projects', { method: 'POST' })).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
      message: 'Missing CSRF token',
    });
  });

  it('falls back to a status message when the body is not an envelope', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('<html>502</html>', { status: 502 })),
    );
    await expect(apiFetch('/projects')).rejects.toMatchObject({
      status: 502,
      code: 'unknown',
    });
  });
});

describe('apiUrl', () => {
  it('prefixes a bare route', () => {
    expect(apiUrl('/projects/p1/ir')).toBe(`http://localhost:3001${API_PREFIX}/projects/p1/ir`);
    expect(apiUrl('/auth/login')).toBe(`http://localhost:3001${API_PREFIX}/auth/login`);
  });

  it('does not double-prefix a route that already carries it', () => {
    expect(apiUrl('/api/auth/login')).toBe('http://localhost:3001/api/auth/login');
  });

  it('keeps the query string intact', () => {
    expect(apiUrl('/projects/p1/access?explain=1')).toBe(
      'http://localhost:3001/api/projects/p1/access?explain=1',
    );
  });
});

/** `RequestInfo | URL` is a union of three shapes; `String()` on a Request gives
 *  "[object Object]" and the assertion would silently never match. */
function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe('apiFetch refresh on 401', () => {
  /** 401 once, then whatever `after` says, so a retry can be observed. */
  function expireThen(after: () => Response, refreshOk = true): void {
    let seenRefresh = false;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/refresh')) {
        seenRefresh = true;
        return Promise.resolve(new Response(null, { status: refreshOk ? 204 : 401 }));
      }
      if (!seenRefresh) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'nope' } }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(after());
    });
  }

  const ok = () =>
    new Response(JSON.stringify({ id: 'p1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('refreshes once and retries the original request', async () => {
    expireThen(ok);
    await expect(apiFetch<{ id: string }>('/projects/p1/ir')).resolves.toEqual({ id: 'p1' });

    const urls = fetchMock.mock.calls.map((c) => urlOf(c[0]));
    expect(urls.filter((u) => u.endsWith('/auth/refresh'))).toHaveLength(1);
    // original, refresh, retry
    expect(urls).toHaveLength(3);
  });

  it('does not try to refresh the refresh route itself', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'nope' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(apiFetch('/auth/refresh', { method: 'POST' })).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it('shares ONE refresh across concurrent 401s, so the family is not revoked', async () => {
    // N simultaneous 401s must not rotate the refresh token N times — the API reads
    // concurrent rotations as token reuse and revokes the whole family.
    expireThen(ok);
    await Promise.all([
      apiFetch('/projects/p1/ir'),
      apiFetch('/projects/p1/snapshots'),
      apiFetch('/organizations'),
    ]);
    const refreshes = fetchMock.mock.calls
      .map((c) => urlOf(c[0]))
      .filter((u) => u.endsWith('/auth/refresh'));
    expect(refreshes).toHaveLength(1);
  });
});

describe('toApiError', () => {
  it('says what a read-only (423) project needs instead of a generic failure', () => {
    const error = toApiError(423, { error: { code: 'engine.read-only' } });
    expect(error.code).toBe('engine.read-only');
    expect(error.message).toMatch(/read-only until an operator upgrades its engine/);
  });
});
