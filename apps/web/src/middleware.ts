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
export const PATHNAME_HEADER = 'x-sl-pathname';

/** The `(auth)` route group. Reachable without the cookie; redundant with it. */
const AUTH_ROUTES = [
  '/login',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/magic-link',
  '/two-factor',
];

/**
 * Reachable with OR without the cookie, and never bounced. An invite link (R11) is opened
 * by people with no account and by people already signed in; the second must stay on the
 * page to accept it, not be sent to `/`.
 */
const OPEN_ROUTES = ['/invite'];

const under = (routes: readonly string[], pathname: string): boolean =>
  routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));

function isAuthRoute(pathname: string): boolean {
  return under(AUTH_ROUTES, pathname);
}

export function middleware(request: NextRequest): NextResponse {
  const hasPresence = request.cookies.has(PRESENCE_COOKIE);
  const { pathname, search } = request.nextUrl;
  const onAuthRoute = isAuthRoute(pathname);
  const onOpenRoute = under(OPEN_ROUTES, pathname);

  if (!hasPresence && !onAuthRoute && !onOpenRoute) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(url, 307);
  }

  // `?expired=1` is the way OUT of a dead session: `sl_presence` (30 days) outlives
  // `sl_access` (15 minutes), and bouncing this back to `/` would loop forever.
  const expired = request.nextUrl.searchParams.get('expired') === '1';
  if (hasPresence && onAuthRoute && !expired) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url, 307);
  }

  // Server Components cannot see the URL; `serverFetch` needs it for `?next=` on a 401.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(PATHNAME_HEADER, `${pathname}${search}`);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // `s/`: a share-link visitor has no sl_presence cookie and must reach /s/[token]
  // without being bounced to /login (doc 01 §5.4).
  matcher: ['/((?!_next/static|_next/image|favicon.ico|sw\\.js|fonts|s/|.*\\.(?:svg|png|webp)$).*)'],
};
