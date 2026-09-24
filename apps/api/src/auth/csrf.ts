import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Doc 01 §4.5 — the `sl_csrf` double-submit token.
 *
 * Shape: `<nonce>.<hmac(CSRF_SECRET, nonce)>`. The HMAC is what makes this more than a
 * plain double-submit cookie: an attacker who can *set* a cookie on the API origin (a
 * subdomain takeover, a cookie-tossing bug) can otherwise choose both halves of a
 * double-submit pair and forge a matching header. Without the secret they cannot
 * produce a token this function will accept.
 *
 * The token carries no authority on its own — possession proves nothing without the
 * httpOnly session cookie. That is why it is deliberately readable by the SPA.
 */
export function issueCsrfToken(secret: string): string {
  const nonce = randomBytes(18).toString('base64url');
  return `${nonce}.${sign(nonce, secret)}`;
}

function sign(nonce: string, secret: string): string {
  return createHmac('sha256', secret).update(nonce).digest('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself a (harmless, since
  // length is not secret) early exit. Guarding keeps it from being a 500.
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** True only when the header equals the cookie AND the cookie's HMAC verifies. */
export function verifyCsrfToken(
  cookieValue: string | undefined,
  headerValue: string | undefined,
  secret: string,
): boolean {
  if (!cookieValue || !headerValue) return false;
  if (!constantTimeEquals(cookieValue, headerValue)) return false;
  const dot = cookieValue.indexOf('.');
  if (dot < 1) return false;
  const nonce = cookieValue.slice(0, dot);
  const mac = cookieValue.slice(dot + 1);
  return constantTimeEquals(mac, sign(nonce, secret));
}
