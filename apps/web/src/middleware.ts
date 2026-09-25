import { NextResponse, type NextRequest } from 'next/server';

/**
 * NOT AN AUTHORISATION BOUNDARY. Read this before adding anything to it.
 *
 * This middleware answers exactly one question — "does the visitor carry the
 * `sl_presence` cookie?" — and redirects on the answer. It never verifies a
 * signature, never fetches, never reads a body, and never decides what anyone may
 * see. `sl_presence` is the literal string `1`; it is not a token and grants nothing.
 *
 * The API is the source of truth (doc 01 §5.4). Every real check — is the access
 * token valid, unexpired and unrevoked, who is this user, which org, which role, which
 * fields survive redaction — happens there, in `PermissionGuard` and
 * `VisibilityFilter`. Forging `sl_presence` gets you an app shell whose first request
 * 401s and bounces you straight back here.
 *
 * That is the whole design: no JWT secret at the edge, no refresh token on a shared
 * cookie domain, sub-millisecond edge cost. A middleware that LOOKS like a guard is
 * dangerous precisely because the next person will trust it and skip the API check.
 * If you are about to add a permission test here, it belongs in the API instead.
 */
const PRESENCE_COOKIE = 'sl_presence';

/** The `(auth)` route group. Reachable without the cookie; redundant with it. */
const AUTH_ROUTES = [
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/magic-link',
  '/two-factor',
  '/invite',
];

function isAuthRoute(pathname: string): boolean {
  return AUTH_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

export function middleware(request: NextRequest): NextResponse {
  const hasPresence = request.cookies.has(PRESENCE_COOKIE);
  const { pathname, search } = request.nextUrl;
  const onAuthRoute = isAuthRoute(pathname);

  if (!hasPresence && !onAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(url, 307);
  }

  if (hasPresence && onAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url, 307);
  }

  return NextResponse.next();
}

export const config = {
  // Phase 3 adds `|s` to this lookahead: a share-link visitor has no sl_presence
  // cookie and must reach /s/[token] without being bounced to /login.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|fonts|.*\\.(?:svg|png|webp)$).*)'],
};
