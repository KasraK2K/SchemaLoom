import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { parseCookieHeader } from '../common/cookies.middleware';
import { AUTHORITY_COOKIES, COOKIE_NAMES } from './cookies';
import { verifyCsrfToken } from './csrf';

export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Doc 01 §5.4: `POST /s/:token/unlock` is protected by its per-IP and per-link rate
 * limits, not CSRF. It must be reachable by a visitor who still holds an `sl_session`
 * from ANOTHER link — that cookie is authority, and without this the second link they
 * open is a 403. The worst a forged unlock does is swap in a view-only session for a
 * link the attacker already holds; a user session still wins in `JwtAuthGuard`.
 */
const SHARE_UNLOCK = /^\/api\/s\/[^/]+\/unlock$/;

/**
 * Doc 01 §4.5 — the verifier half. Mounted in `main.ts` after `cookieMiddleware`;
 * `AuthModule` owns issuance. Both halves ship together because a verifier with
 * nothing issuing the cookie rejects every write in the product.
 *
 * Exemptions, and why they are not holes:
 *
 * - `GET`/`HEAD`/`OPTIONS`, including the SSE stream.
 * - Requests carrying **no authority cookie at all**. §4.5 phrases this as "`@Public()`
 *   routes are exempt", but route metadata does not exist yet at middleware time —
 *   Nest's router has not matched. Keying on the cookies instead lands on the same set
 *   for the same reason the doc gives: a request with no session cookie has no
 *   authority for a cross-site POST to borrow, so forging it accomplishes nothing.
 *   It also fails *closed* in the direction that matters — any authenticated request,
 *   public route or not, is checked.
 * - Share-link sessions are NOT exempt (§4.5): `sl_session` is a cookie and would be as
 *   forgeable cross-site as any other. It is in `AUTHORITY_COOKIES`.
 *
 * Reads the cookie header directly rather than `req.cookies`, whose Express type is
 * `any`; re-parsing one header is cheaper than the cast it would take to use it safely.
 */
export function createCsrfMiddleware(secret: string): RequestHandler {
  return function verifyCsrf(req: Request, res: Response, next: NextFunction): void {
    if (SAFE_METHODS.has(req.method) || SHARE_UNLOCK.test(req.path)) {
      next();
      return;
    }
    const cookies = parseCookieHeader(req.headers.cookie);
    if (!AUTHORITY_COOKIES.some((name) => name in cookies)) {
      next();
      return;
    }
    const header = req.headers[CSRF_HEADER];
    const headerValue = Array.isArray(header) ? header[0] : header;
    if (!verifyCsrfToken(cookies[COOKIE_NAMES.csrf], headerValue, secret)) {
      res.status(403).json({
        statusCode: 403,
        error: 'Forbidden',
        code: 'CSRF_TOKEN_INVALID',
        message: 'Missing or invalid X-CSRF-Token.',
      });
      return;
    }
    next();
  };
}
