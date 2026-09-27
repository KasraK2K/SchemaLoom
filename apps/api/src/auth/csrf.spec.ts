import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { COOKIE_NAMES } from './cookies';
import { issueCsrfToken, verifyCsrfToken } from './csrf';
import { CSRF_HEADER, createCsrfMiddleware } from './csrf.middleware';

const SECRET = 'csrf-secret-for-tests';

describe('issueCsrfToken / verifyCsrfToken', () => {
  it('verifies a freshly issued token', () => {
    const token = issueCsrfToken(SECRET);
    expect(verifyCsrfToken(token, token, SECRET)).toBe(true);
  });

  it('rejects a tampered nonce, a tampered mac, and a truncated token', () => {
    const token = issueCsrfToken(SECRET);
    const [nonce = '', mac = ''] = token.split('.');
    expect(verifyCsrfToken(`${nonce}x.${mac}`, `${nonce}x.${mac}`, SECRET)).toBe(false);
    expect(verifyCsrfToken(`${nonce}.${mac}x`, `${nonce}.${mac}x`, SECRET)).toBe(false);
    expect(verifyCsrfToken(nonce, nonce, SECRET)).toBe(false);
  });

  it('rejects a token minted under a different secret', () => {
    const token = issueCsrfToken('another-secret');
    expect(verifyCsrfToken(token, token, SECRET)).toBe(false);
  });

  it('rejects a header that does not match the cookie', () => {
    const cookie = issueCsrfToken(SECRET);
    expect(verifyCsrfToken(cookie, issueCsrfToken(SECRET), SECRET)).toBe(false);
    expect(verifyCsrfToken(cookie, undefined, SECRET)).toBe(false);
    expect(verifyCsrfToken(undefined, cookie, SECRET)).toBe(false);
  });
});

function call(method: string, cookie: string | undefined, header?: string, path = '/api/x') {
  const req = { method, path, headers: { cookie, [CSRF_HEADER]: header } } as unknown as Request;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() };
  const next = vi.fn();
  createCsrfMiddleware(SECRET)(req, res as unknown as Response, next);
  return { res, next };
}

describe('csrf middleware', () => {
  it('lets safe methods through even with cookies present', () => {
    const token = issueCsrfToken(SECRET);
    expect(call('GET', `sl_access=a; ${COOKIE_NAMES.csrf}=${token}`).next).toHaveBeenCalled();
  });

  it('lets an unauthenticated write through — there is no authority to borrow', () => {
    expect(call('POST', undefined).next).toHaveBeenCalled();
    expect(call('POST', 'unrelated=1').next).toHaveBeenCalled();
  });

  it('accepts an authenticated write carrying the matching header', () => {
    const token = issueCsrfToken(SECRET);
    const { next, res } = call('POST', `sl_access=a; ${COOKIE_NAMES.csrf}=${token}`, token);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects an authenticated write with a tampered header', () => {
    const token = issueCsrfToken(SECRET);
    const { next, res } = call(
      'DELETE',
      `sl_access=a; ${COOKIE_NAMES.csrf}=${token}`,
      `${token}x`,
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects an authenticated write with no header at all', () => {
    const token = issueCsrfToken(SECRET);
    const { next, res } = call('PATCH', `sl_access=a; ${COOKIE_NAMES.csrf}=${token}`);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('does not exempt a share-link session — sl_session is a cookie like any other', () => {
    const { next, res } = call('POST', `${COOKIE_NAMES.session}=whatever`);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('exempts exactly the share-link unlock, which the rate limiter guards instead', () => {
    const cookie = `${COOKIE_NAMES.session}=from-another-link`;
    expect(call('POST', cookie, undefined, '/api/s/tok123/unlock').next).toHaveBeenCalled();
    expect(call('POST', cookie, undefined, '/api/s/tok123/unlock/x').next).not.toHaveBeenCalled();
    expect(call('POST', cookie, undefined, '/api/s/a/b/unlock').next).not.toHaveBeenCalled();
  });
});
