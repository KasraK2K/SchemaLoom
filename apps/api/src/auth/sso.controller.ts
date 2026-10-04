import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { CookieOptions, Request, Response } from 'express';
import type Redis from 'ioredis';
import { randomBytes } from 'node:crypto';
import { Authenticated } from '../access';
import { parseCookieHeader } from '../common/cookies.middleware';
import type { AppEnv } from '../config/env';
import { REDIS_CACHE } from '../redis/redis.tokens';
import { SsoConnectionDto, SsoDiscoverDto } from './auth.dto';
import { AuthService } from './auth.service';
import { cookiePolicyFrom, setUserSessionCookies } from './cookies';
import { Public } from './public.decorator';
import {
  oidcFinish,
  oidcStart,
  redisSamlCache,
  samlClient,
  samlEndpoints,
  samlIdentity,
  type OidcPending,
} from './sso.protocols';
import {
  SsoService,
  type SsoConnectionRecord,
  type SsoConnectionView,
  type SsoIdentity,
} from './sso.service';

/** The browser's half of a sign-in in flight: signed, 10 minutes, only sent to /api/auth/sso. */
const SSO_COOKIE = 'sl_sso';
const SSO_TTL_SEC = 10 * 60;
const SSO_AUDIENCE = 'sl_sso';

interface Pending {
  /** connection id */
  readonly cid: string;
  /** where to land afterwards, a same-site path */
  readonly next: string;
  readonly oidc?: OidcPending;
  /** SAML: echoed back as RelayState, binding the IdP's response to this browser */
  readonly rs?: string;
}

type ConnectionView = SsoConnectionView & {
  readonly sp:
    | { readonly redirectUri: string }
    | { readonly entityId: string; readonly acsUrl: string; readonly metadataUrl: string };
};

/** A same-site path or nothing: `next` must never send the browser to another host. */
function safeNext(next: unknown): string {
  return typeof next === 'string' && /^\/(?![/\\])/.test(next) ? next : '/';
}

/** The IdP's form post to the ACS is cross-site, so this cookie must be `SameSite=None`. */
function ssoCookieOptions(maxAgeSec: number): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'none',
    path: '/api/auth/sso',
    maxAge: maxAgeSec * 1000,
  };
}

function userIdOf(req: Request): string {
  const principal = req.auth;
  if (principal?.kind !== 'user') throw new UnauthorizedException({ code: 'NOT_AUTHENTICATED' });
  return principal.userId;
}

/**
 * Roadmap 14 §1 — SSO connections (org owners) and the sign-in round trip (public).
 * Every route carries one marker; none is a share-link route.
 */
@ApiTags('sso')
@Controller()
export class SsoController {
  private readonly logger = new Logger(SsoController.name);

  constructor(
    private readonly sso: SsoService,
    private readonly auth: AuthService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
    @Inject(REDIS_CACHE) private readonly redis: Redis,
  ) {
    this.apiPublicUrl = config.get('API_PUBLIC_URL', { infer: true }).replace(/\/+$/, '');
    this.webPublicUrl = config.get('WEB_PUBLIC_URL', { infer: true }).replace(/\/+$/, '');
    this.allowPrivate = config.get('INTROSPECT_ALLOW_PRIVATE_HOSTS', { infer: true });
    this.secret = config.get('JWT_ACCESS_SECRET', { infer: true });
  }

  private readonly apiPublicUrl: string;
  private readonly webPublicUrl: string;
  private readonly allowPrivate: boolean;
  private readonly secret: string;

  // ------------------------------------------------------------- management

  @ApiOperation({ summary: 'SSO connections of the organisation (owner)' })
  @Authenticated()
  @Get('organizations/:orgSlug/sso-connections')
  async list(@Req() req: Request, @Param('orgSlug') orgSlug: string): Promise<ConnectionView[]> {
    return (await this.sso.list(userIdOf(req), orgSlug)).map((c) => this.withSp(c));
  }

  @ApiOperation({ summary: 'Add an SSO connection (owner)' })
  @Authenticated()
  @Post('organizations/:orgSlug/sso-connections')
  async create(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Body() dto: SsoConnectionDto,
  ): Promise<ConnectionView> {
    return this.withSp(await this.sso.create(userIdOf(req), orgSlug, dto));
  }

  @ApiOperation({ summary: 'Edit an SSO connection (owner)' })
  @Authenticated()
  @Patch('organizations/:orgSlug/sso-connections/:id')
  async update(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('id') id: string,
    @Body() dto: SsoConnectionDto,
  ): Promise<ConnectionView> {
    return this.withSp(await this.sso.update(userIdOf(req), orgSlug, id, dto));
  }

  @ApiOperation({ summary: 'Remove an SSO connection (owner)' })
  @Authenticated()
  @HttpCode(204)
  @Delete('organizations/:orgSlug/sso-connections/:id')
  async remove(
    @Req() req: Request,
    @Param('orgSlug') orgSlug: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.sso.remove(userIdOf(req), orgSlug, id);
  }

  // --------------------------------------------------------------- sign-in

  @ApiOperation({ summary: 'Which SSO connections sign this address in' })
  @Public()
  @HttpCode(200)
  @Post('auth/sso/discover')
  async discover(
    @Body() dto: SsoDiscoverDto,
  ): Promise<{ connections: { id: string; name: string }[] }> {
    return { connections: await this.sso.discover(dto.email) };
  }

  @Public()
  @ApiExcludeEndpoint()
  @Get('auth/sso/:id/start')
  async start(
    @Param('id') id: string,
    @Query('next') next: unknown,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const conn = await this.sso.record(id);
      const base = { cid: conn.id, next: safeNext(next) };
      let url: string;
      let pending: Pending;
      if (conn.protocol === 'oidc') {
        const started = await oidcStart(
          conn,
          `${this.apiPublicUrl}/api/auth/sso/oidc/callback`,
          this.allowPrivate,
        );
        url = started.url;
        pending = { ...base, oidc: started.pending };
      } else {
        const rs = randomBytes(16).toString('base64url');
        url = await this.saml(conn).getAuthorizeUrlAsync(rs, undefined, {});
        pending = { ...base, rs };
      }
      const token = await this.jwt.signAsync(
        { ...pending },
        { secret: this.secret, audience: SSO_AUDIENCE, expiresIn: SSO_TTL_SEC },
      );
      res.cookie(SSO_COOKIE, token, ssoCookieOptions(SSO_TTL_SEC));
      res.redirect(url);
    } catch (error) {
      this.fail(res, error);
    }
  }

  @Public()
  @ApiExcludeEndpoint()
  @Get('auth/sso/oidc/callback')
  async oidcCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      const pending = await this.pending(req);
      if (pending.oidc === undefined) throw new UnauthorizedException({ code: 'sso_state' });
      const conn = await this.sso.record(pending.cid);
      const identity = await oidcFinish(
        conn,
        new URL(`${this.apiPublicUrl}${req.originalUrl}`),
        pending.oidc,
        this.allowPrivate,
      );
      await this.finish(req, res, conn, identity, pending.next);
    } catch (error) {
      this.fail(res, error);
    }
  }

  /** The IdP's form post. CSRF-exempt (`csrf.middleware.ts`): the signed assertion, the
   *  one-time InResponseTo and the RelayState matched against `sl_sso` stand in for it. */
  @Public()
  @ApiExcludeEndpoint()
  @HttpCode(302)
  @Post('auth/sso/saml/acs')
  async samlAcs(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: Record<string, unknown>,
  ): Promise<void> {
    try {
      const pending = await this.pending(req);
      const response = body.SAMLResponse;
      if (
        pending.rs === undefined ||
        body.RelayState !== pending.rs ||
        typeof response !== 'string'
      )
        throw new UnauthorizedException({ code: 'sso_state' });
      const conn = await this.sso.record(pending.cid);
      const { profile } = await this.saml(conn).validatePostResponseAsync({
        SAMLResponse: response,
        RelayState: pending.rs,
      });
      if (profile === null) throw new UnauthorizedException({ code: 'sso_failed' });
      await this.finish(req, res, conn, samlIdentity(profile), pending.next);
    } catch (error) {
      this.fail(res, error);
    }
  }

  /** What the IdP admin pastes in. Public: SP metadata holds nothing secret. */
  @Public()
  @ApiExcludeEndpoint()
  @Get('auth/sso/:id/saml/metadata')
  async samlMetadata(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const conn = await this.sso.record(id);
    if (conn.protocol !== 'saml') throw new NotFoundException({ code: 'not_found' });
    res
      .type('application/samlmetadata+xml')
      .send(this.saml(conn).generateServiceProviderMetadata(null, null));
  }

  /** The values the IdP admin needs from our side, shown on the settings page. */
  private withSp(c: SsoConnectionView): ConnectionView {
    const saml = samlEndpoints(this.apiPublicUrl, c.id);
    return {
      ...c,
      sp:
        c.protocol === 'oidc'
          ? { redirectUri: `${this.apiPublicUrl}/api/auth/sso/oidc/callback` }
          : { ...saml, metadataUrl: saml.entityId },
    };
  }

  private saml(conn: SsoConnectionRecord) {
    return samlClient(conn, this.apiPublicUrl, redisSamlCache(this.redis, SSO_TTL_SEC));
  }

  private async pending(req: Request): Promise<Pending> {
    const token = parseCookieHeader(req.headers.cookie)[SSO_COOKIE];
    if (token === undefined) throw new UnauthorizedException({ code: 'sso_state' });
    try {
      return await this.jwt.verifyAsync<Pending>(token, {
        secret: this.secret,
        audience: SSO_AUDIENCE,
      });
    } catch {
      throw new UnauthorizedException({ code: 'sso_state' });
    }
  }

  private async finish(
    req: Request,
    res: Response,
    conn: SsoConnectionRecord,
    identity: SsoIdentity,
    next: string,
  ): Promise<void> {
    res.clearCookie(SSO_COOKIE, { ...ssoCookieOptions(0), maxAge: undefined });
    const outcome = await this.sso.resolve(conn, identity);
    if ('refused' in outcome) {
      res.redirect(`${this.webPublicUrl}/login?sso_error=${outcome.refused}`);
      return;
    }
    const bundle = await this.auth.openSsoSession(
      outcome.userId,
      { userAgent: req.headers['user-agent'], ip: req.ip },
      conn.organizationId,
    );
    setUserSessionCookies(res, cookiePolicyFrom(this.config), bundle);
    res.redirect(`${this.webPublicUrl}${next}`);
  }

  /** A top-level navigation can't show a JSON error: back to the sign-in page with a code. */
  private fail(res: Response, error: unknown): void {
    const body = error instanceof HttpException ? error.getResponse() : null;
    const code =
      typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string'
        ? body.code
        : 'sso_failed';
    if (!(error instanceof HttpException)) this.logger.warn({ err: error }, 'sso sign-in failed');
    res.redirect(`${this.webPublicUrl}/login?sso_error=${encodeURIComponent(code)}`);
  }
}
