/**
 * The module's public surface. `app.module.ts` and `main.ts` import from here; nothing
 * outside `src/auth/` should reach past this file.
 */
export { AuthModule } from './auth.module';
export { JwtAuthGuard } from './jwt-auth.guard';
export { Public, IS_PUBLIC_KEY } from './public.decorator';
export { createCsrfMiddleware, CSRF_HEADER } from './csrf.middleware';
export { issueCsrfToken, verifyCsrfToken } from './csrf';
export {
  COOKIE_NAMES,
  AUTHORITY_COOKIES,
  REFRESH_COOKIE_PATH,
  cookieOptionsFor,
  cookiePolicyFrom,
  setShareSessionCookie,
  type CookieName,
  type CookiePolicy,
} from './cookies';
export {
  getPrincipal,
  getSubject,
  subjectKey,
  toSubject,
  type AuthPrincipal,
  type Subject,
} from './subject';
export { TokensService, type ShareSessionClaims } from './tokens.service';
export { AuthService } from './auth.service';
