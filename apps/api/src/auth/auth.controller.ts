import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiCookieAuth, ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { parseCookieHeader } from '../common/cookies.middleware';
import type { AppEnv } from '../config/env';
import { AuthService, type MeResponse, type SessionBundle } from './auth.service';
import {
  COOKIE_NAMES,
  clearUserSessionCookies,
  cookieOptionsFor,
  cookiePolicyFrom,
  setUserSessionCookies,
} from './cookies';
import {
  EmailOnlyDto,
  LoginDto,
  RegisterDto,
  ResetPasswordDto,
  SwitchOrgDto,
  TokenDto,
} from './auth.dto';
import { Authenticated } from '../access/route-markers';
import { GoogleAuthGuard } from './google-auth.guard';
import type { OAuthUser } from './google.strategy';
import { Public } from './public.decorator';
import { TokensService } from './tokens.service';

function sessionContext(req: Request): { userAgent?: string; ip?: string } {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}

/** The `sl_org` preference (see `cookies.ts`), re-checked by `AuthService` before use. */
function preferredOrg(req: Request): string | undefined {
  const value = parseCookieHeader(req.headers.cookie)[COOKIE_NAMES.org];
  return value === '' ? undefined : value;
}

@ApiCookieAuth('sl_access')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  private write(res: Response, bundle: SessionBundle): { csrfToken: string } {
    setUserSessionCookies(res, cookiePolicyFrom(this.config), bundle);
    // Also in the body, so a client that has just been redirected across origins can
    // arm its X-CSRF-Token header without waiting for a cookie read.
    return { csrfToken: bundle.csrfToken };
  }

  @Public()
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ csrfToken: string; user: MeResponse }> {
    const userId = await this.auth.register(dto);
    const bundle = await this.auth.issueSession(userId, sessionContext(req));
    return { ...this.write(res, bundle), user: await this.auth.me(userId) };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ csrfToken: string; user: MeResponse }> {
    const userId = await this.auth.login(dto);
    const bundle = await this.auth.issueSession(userId, sessionContext(req), preferredOrg(req));
    return { ...this.write(res, bundle), user: await this.auth.me(userId) };
  }

  /**
   * `@Public()` because the access token is, by definition, expired by the time anyone
   * calls this. The `sl_refresh` cookie is the credential — and CSRF still applies to
   * it (the middleware keys on the cookie, not the route), which is what stops a
   * cross-site page from silently rotating somebody's session.
   */
  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ csrfToken: string }> {
    const token = parseCookieHeader(req.headers.cookie)[COOKIE_NAMES.refresh];
    if (!token) throw new UnauthorizedException({ code: 'REFRESH_TOKEN_MISSING' });
    return this.write(res, await this.auth.refresh(token, sessionContext(req), preferredOrg(req)));
  }

  /**
   * Makes another of the caller's organisations the active one: a new `sl_access` with
   * that `org` claim, and `sl_org` so the next refresh keeps it. Org-gated routes
   * (`@RequireOrgRole`) only ever admit the active org, so this is what lets a user in
   * two orgs create a project in the second.
   */
  @Authenticated()
  @Post('switch-org')
  @HttpCode(200)
  async switchOrg(
    @Req() req: Request,
    @Body() dto: SwitchOrgDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ orgId: string }> {
    const principal = req.auth;
    if (principal?.kind !== 'user') throw new UnauthorizedException({ code: 'NOT_AUTHENTICATED' });
    const { accessToken, accessTtlSec } = await this.auth.switchOrg(
      principal.userId,
      dto.organizationId,
    );
    const policy = cookiePolicyFrom(this.config);
    res.cookie(COOKIE_NAMES.access, accessToken, cookieOptionsFor(COOKIE_NAMES.access, policy, accessTtlSec));
    res.cookie(
      COOKIE_NAMES.org,
      dto.organizationId,
      cookieOptionsFor(COOKIE_NAMES.org, policy, this.tokens.refreshTtlSec),
    );
    return { orgId: dto.organizationId };
  }

  /** Idempotent: the cookies are cleared whether or not the token was still live. */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const token = parseCookieHeader(req.headers.cookie)[COOKIE_NAMES.refresh];
    if (token) await this.tokens.revokeByRefreshToken(token);
    clearUserSessionCookies(res, cookiePolicyFrom(this.config));
  }

  @Public()
  @Post('verify-email')
  @HttpCode(204)
  async verifyEmail(@Body() dto: TokenDto): Promise<void> {
    await this.auth.verifyEmail(dto.token);
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(204)
  async resendVerification(@Body() dto: EmailOnlyDto): Promise<void> {
    await this.auth.resendVerification(dto.email);
  }

  /** Always 204 — answering differently for a known address is an enumeration oracle. */
  @Public()
  @Post('password-reset')
  @HttpCode(204)
  async requestPasswordReset(@Body() dto: EmailOnlyDto): Promise<void> {
    await this.auth.requestPasswordReset(dto.email);
  }

  @Public()
  @Post('password-reset/confirm')
  @HttpCode(204)
  async confirmPasswordReset(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.auth.resetPassword(dto.token, dto.password);
  }

  /**
   * Doc 01 §4.1 — a route that names no resource carries `@Authenticated()` explicitly.
   * The boot sweep cannot tell "any established identity may call this" from "somebody
   * forgot a decorator" unless the decision is written down.
   */
  @Authenticated()
  @Get('me')
  async me(@Req() req: Request): Promise<MeResponse> {
    const principal = req.auth;
    if (principal?.kind !== 'user') throw new UnauthorizedException({ code: 'NOT_AUTHENTICATED' });
    return this.auth.me(principal.userId);
  }

  // ------------------------------------------------------------------- google

  @Public()
  @Get('google')
  @UseGuards(GoogleAuthGuard)
  @ApiExcludeEndpoint()
  startGoogle(): void {
    // The guard redirects to Google; this body never runs.
  }

  @Public()
  @Get('google/callback')
  @UseGuards(GoogleAuthGuard)
  @ApiExcludeEndpoint()
  async googleCallback(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    const user = req.user as OAuthUser | undefined;
    if (!user?.userId) throw new UnauthorizedException({ code: 'OAUTH_FAILED' });
    const bundle = await this.auth.issueSession(user.userId, sessionContext(req), preferredOrg(req));
    this.write(res, bundle);
    res.redirect(this.config.get('WEB_PUBLIC_URL', { infer: true }));
  }
}
