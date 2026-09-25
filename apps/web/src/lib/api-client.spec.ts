import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, CSRF_HEADER, readCookie } from './api-client';

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

  it('prefixes the configured API origin', async () => {
    await apiFetch('/me');
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('http://localhost:3001/me');
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
