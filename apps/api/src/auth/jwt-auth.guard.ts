import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { parseCookieHeader } from '../common/cookies.middleware';
import { COOKIE_NAMES } from './cookies';
import { IS_PUBLIC_KEY } from './public.decorator';
import type { AuthPrincipal } from './subject';
import { TokensService } from './tokens.service';

/**
 * Doc 01 §4.1 — the FIRST `APP_GUARD`, ahead of `PermissionGuard`. It answers exactly
 * one question ("who is this?") and attaches the answer as `req.auth`; every
 * permission decision belongs to the resolver behind it.
 *
 * It resolves **both** subject kinds doc 05 §7.1 names:
 *
 * - `sl_access` -> `{ kind: 'user', userId, orgId }`
 * - `sl_session` -> `{ kind: 'share_link', shareLinkId, projectId, resourceId }`
 *
 * A `@Public()` route still gets `req.auth` populated when the cookies are there — a
 * public route that renders differently for a signed-in visitor needs to know, and the
 * alternative is every such route re-parsing the cookie itself.
 *
 * Neither cookie is trusted past its signature: the share-link principal's authority
 * comes from the `AccessGrant` its id resolves to, and revoking the link deletes that
 * grant (§7.12). This guard deliberately does not check liveness — that is R12's job
 * and it is a database read, not an auth concern.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokensService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request>();
    request.auth = await this.principalFromCookies(request.headers.cookie);

    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;
    if (!request.auth) throw new UnauthorizedException({ code: 'NOT_AUTHENTICATED' });
    return true;
  }

  /**
   * Public so the realtime handshake (doc 01 §4.5: the upgrade authenticates with the
   * same cookies) resolves subjects exactly as HTTP does, with no second copy.
   */
  async principalFromCookies(header: string | undefined): Promise<AuthPrincipal | undefined> {
    const cookies = parseCookieHeader(header);

    const access = cookies[COOKIE_NAMES.access];
    if (access) {
      const claims = await this.tokens.verifyAccessToken(access);
      if (claims) return { kind: 'user', userId: claims.userId, orgId: claims.orgId };
    }

    // A user cookie that failed to verify does not fall through to the share-link
    // cookie as a *stronger* identity — it falls through to a weaker one, which is safe.
    const session = cookies[COOKIE_NAMES.session];
    if (session) {
      const claims = await this.tokens.verifyShareSession(session);
      if (claims) {
        return {
          kind: 'share_link',
          shareLinkId: claims.shareLinkId,
          projectId: claims.projectId,
          resourceId: claims.resourceId,
        };
      }
    }
    return undefined;
  }
}
