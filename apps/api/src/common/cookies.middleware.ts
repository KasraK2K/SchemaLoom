import type { NextFunction, Request, Response } from 'express';

/**
 * Cookie parsing, mounted in `main.ts` before everything that reads a cookie —
 * the auth guard (`sl_access`/`sl_session`) and the CSRF middleware (`sl_csrf`,
 * doc 01 §4.5).
 *
 * Deliberately not `cookie-parser`: SchemaLoom uses no signed cookies (the `sl_csrf`
 * double-submit token is HMAC'd with `CSRF_SECRET` by `AuthModule`, and the session
 * cookies carry JWTs that are verified on their own), so the package's entire value
 * over these ten lines would be the signature helper we do not use.
 */
export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (name.length === 0 || name in out) continue;
    const raw = part.slice(eq + 1).trim();
    const value = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      // A malformed percent-escape is a malformed cookie, not a 500.
      out[name] = value;
    }
  }
  return out;
}

export function cookieMiddleware(req: Request, _res: Response, next: NextFunction): void {
  req.cookies = parseCookieHeader(req.headers.cookie);
  next();
}
