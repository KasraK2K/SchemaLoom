import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Appearance } from '@schemaloom/contracts';
import { ApiCookieAuth, ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { parseCookieHeader } from '../common/cookies.middleware';
import type { AppEnv } from '../config/env';
import {
  AuthService,
  isMfaChallenge,
  type LoginOutcome,
  type MeResponse,
  type SessionBundle,
} from './auth.service';
import {
  COOKIE_NAMES,
  clearMfaChallengeCookie,
  clearUserSessionCookies,
  cookieOptionsFor,
  cookiePolicyFrom,
  setMfaChallengeCookie,
  setUserSessionCookies,
} from './cookies';
import {
  AppearanceDto,
  CodeDto,
  DisableTwoFactorDto,
  EmailOnlyDto,
  LoginDto,
  MagicLinkDto,
  RegisterDto,
  ResetPasswordDto,
  SwitchOrgDto,
  TokenDto,
} from './auth.dto';
import { Authenticated } from '../access/route-markers';
import { GitHubAuthGuard } from './github-auth.guard';
import { isGitHubConfigured } from './github.strategy';
import { GoogleAuthGuard } from './google-auth.guard';
import { isGoogleConfigured, type OAuthUser } from './google.strategy';
import { Public } from './public.decorator';
import { SignupPolicy } from './signup-policy';
import { MFA_CHALLENGE_TTL_SEC, TokensService, type DeviceSession } from './tokens.service';
import { TwoFactorService } from './two-factor.service';

function sessionContext(req: Request): { userAgent?: string; ip?: string } {
  return { userAgent: req.headers['user-agent'], ip: req.ip };
}

/** The `sl_org` preference (see `cookies.ts`), re-checked by `AuthService` before use. */
function preferredOrg(req: Request): string | undefined {
  const value = parseCookieHeader(req.headers.cookie)[COOKIE_NAMES.org];
  return value === '' ? undefined : value;
}

function cookie(req: Request, name: string): string | undefined {
  return parseCookieHeader(req.headers.cookie)[name];
}

function userIdOf(req: Request): string {
  const principal = req.auth;
  if (principal?.kind !== 'user') throw new UnauthorizedException({ code: 'NOT_AUTHENTICATED' });
  return principal.userId;
}

/** A finished login, or — for a 2FA user — the instruction to go and fetch a code. */
type LoginResponse = { csrfToken: string; user: MeResponse } | { mfaRequired: true };

@ApiCookieAuth('sl_access')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokensService,
    private readonly twoFactor: TwoFactorService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly signup: SignupPolicy,
  ) {}

  private write(res: Response, bundle: SessionBundle): { csrfToken: string } {
    setUserSessionCookies(res, cookiePolicyFrom(this.config), bundle);
    // Also in the body, so a client that has just been redirected across origins can
    // arm its X-CSRF-Token header without waiting for a cookie read.
    return { csrfToken: bundle.csrfToken };
  }

  /** Every first-factor route answers through here, so none can skip the 2FA branch. */
  private async respond(res: Response, outcome: LoginOutcome): Promise<LoginResponse> {
    if (isMfaChallenge(outcome)) {
      const policy = cookiePolicyFrom(this.config);
      setMfaChallengeCookie(res, policy, outcome.mfaChallenge, MFA_CHALLENGE_TTL_SEC);
      return { mfaRequired: true };
    }
    return { ...this.write(res, outcome), user: await this.auth.me(outcome.userId) };
  }

  /** OAuth callbacks are top-level navigations, so their 2FA branch is a redirect. */
  private redirectAfterOAuth(res: Response, outcome: LoginOutcome): void {
    const web = this.config.get('WEB_PUBLIC_URL', { infer: true });
    if (isMfaChallenge(outcome)) {
      const policy = cookiePolicyFrom(this.config);
      setMfaChallengeCookie(res, policy, outcome.mfaChallenge, MFA_CHALLENGE_TTL_SEC);
      res.redirect(`${web.replace(/\/+$/, '')}/two-factor`);
      return;
    }
    this.write(res, outcome);
    res.redirect(web);
  }

  /** Whether the sign-up form is open to anyone right now (roadmap 16). */
  @Public()
  @Get('signup-policy')
  async signupPolicy(): Promise<{ open: boolean }> {
    return { open: await this.signup.isOpen() };
  }

  @Public()
  @Post('register')
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const userId = await this.auth.register(dto);
    return this.respond(res, await this.auth.issueSession(userId, sessionContext(req)));
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const userId = await this.auth.login(dto);
    return this.respond(
      res,
      await this.auth.issueSession(userId, sessionContext(req), preferredOrg(req)),
    );
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
    const token = cookie(req, COOKIE_NAMES.refresh);
    if (!token) {
      // Nothing can revive this session, so drop what's left of it. A leftover
      // `sl_presence` (30 days, and `localhost` cookies ignore the port) otherwise makes
      // the web middleware bounce /signup back to /login forever. Only here: an invalid
      // token can be the loser of a two-tab rotation race, and clearing would log out
      // the winner.
      clearUserSessionCookies(res, cookiePolicyFrom(this.config));
      throw new UnauthorizedException({ code: 'REFRESH_TOKEN_MISSING' });
    }
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
    const { accessToken, accessTtlSec } = await this.auth.switchOrg(
      userIdOf(req),
      dto.organizationId,
    );
    const policy = cookiePolicyFrom(this.config);
    res.cookie(
      COOKIE_NAMES.access,
      accessToken,
      cookieOptionsFor(COOKIE_NAMES.access, policy, accessTtlSec),
    );
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
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = cookie(req, COOKIE_NAMES.refresh);
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
    return this.auth.me(userIdOf(req));
  }

  /** The caller's theme, colour variant and mode, so the choice follows them across devices. */
  @Authenticated()
  @Put('me/appearance')
  async setAppearance(@Req() req: Request, @Body() dto: AppearanceDto): Promise<Appearance> {
    return this.auth.setAppearance(userIdOf(req), dto);
  }

  /** Which OAuth buttons the login page draws. A provider with no credentials has no route. */
  @Public()
  @Get('providers')
  providers(): { google: boolean; github: boolean } {
    return { google: isGoogleConfigured(this.config), github: isGitHubConfigured(this.config) };
  }

  // --------------------------------------------------------------- magic link

  /** Always 202 — the same answer for a known address, an unknown one and a new one. */
  @Public()
  @Post('magic-link')
  @HttpCode(202)
  async requestMagicLink(@Body() dto: MagicLinkDto): Promise<void> {
    await this.auth.requestMagicLink(dto.email, dto.next);
  }

  /** A POST from the SPA page, never a GET from the email — see `MailService`. */
  @Public()
  @Post('magic-link/consume')
  @HttpCode(200)
  async consumeMagicLink(
    @Body() dto: TokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const userId = await this.auth.consumeMagicLink(dto.token);
    return this.respond(
      res,
      await this.auth.issueSession(userId, sessionContext(req), preferredOrg(req)),
    );
  }

  // ---------------------------------------------------------------------- 2FA

  /** The second half of a 2FA login. `sl_mfa` is the credential; see `cookies.ts`. */
  @Public()
  @Post('2fa/verify')
  @HttpCode(200)
  async verifyTwoFactor(
    @Body() dto: CodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const challenge = cookie(req, COOKIE_NAMES.mfa);
    if (!challenge) throw new UnauthorizedException({ code: 'MFA_CHALLENGE_INVALID' });
    const bundle = await this.auth.completeMfa(
      challenge,
      dto.code,
      sessionContext(req),
      preferredOrg(req),
    );
    clearMfaChallengeCookie(res, cookiePolicyFrom(this.config));
    return this.respond(res, bundle);
  }

  @Authenticated()
  @Post('2fa/enrol')
  @HttpCode(200)
  enrolTwoFactor(@Req() req: Request): Promise<{ secret: string; otpauthUri: string }> {
    return this.twoFactor.enrol(userIdOf(req));
  }

  @Authenticated()
  @Post('2fa/confirm')
  @HttpCode(200)
  async confirmTwoFactor(
    @Req() req: Request,
    @Body() dto: CodeDto,
  ): Promise<{ recoveryCodes: string[] }> {
    const recoveryCodes = await this.twoFactor.confirm(
      userIdOf(req),
      dto.code,
      sessionContext(req),
    );
    return { recoveryCodes };
  }

  @Authenticated()
  @Post('2fa/disable')
  @HttpCode(204)
  async disableTwoFactor(@Req() req: Request, @Body() dto: DisableTwoFactorDto): Promise<void> {
    await this.twoFactor.disable(userIdOf(req), dto, sessionContext(req));
  }

  @Authenticated()
  @Post('2fa/recovery-codes')
  @HttpCode(200)
  async regenerateRecoveryCodes(
    @Req() req: Request,
    @Body() dto: CodeDto,
  ): Promise<{ recoveryCodes: string[] }> {
    const recoveryCodes = await this.twoFactor.regenerateRecoveryCodes(userIdOf(req), dto.code);
    return { recoveryCodes };
  }

  // ------------------------------------------------------------ device sessions

  /** Under `/api/auth` so `sl_refresh` rides along and "this device" can be flagged. */
  @Authenticated()
  @Get('sessions')
  async listSessions(
    @Req() req: Request,
  ): Promise<{ sessions: (DeviceSession & { current: boolean })[] }> {
    const current = await this.currentFamily(req);
    const devices = await this.tokens.listDevices(userIdOf(req));
    return { sessions: devices.map((d) => ({ ...d, current: d.familyId === current })) };
  }

  /** Someone else's device is a 404, the same as one that does not exist. */
  @Authenticated()
  @Delete('sessions/:familyId')
  @HttpCode(204)
  async revokeSession(@Req() req: Request, @Param('familyId') familyId: string): Promise<void> {
    if (!(await this.tokens.revokeFamilyForUser(userIdOf(req), familyId))) {
      throw new NotFoundException({ code: 'not_found' });
    }
  }

  @Authenticated()
  @Post('sessions/revoke-others')
  @HttpCode(204)
  async revokeOtherSessions(@Req() req: Request): Promise<void> {
    await this.tokens.revokeOtherFamilies(userIdOf(req), await this.currentFamily(req));
  }

  private async currentFamily(req: Request): Promise<string | null> {
    const token = cookie(req, COOKIE_NAMES.refresh);
    return token ? this.tokens.familyOf(token) : null;
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
    await this.finishOAuth(req, res);
  }

  // ------------------------------------------------------------------- github

  @Public()
  @Get('github')
  @UseGuards(GitHubAuthGuard)
  @ApiExcludeEndpoint()
  startGitHub(): void {
    // The guard redirects to GitHub; this body never runs.
  }

  @Public()
  @Get('github/callback')
  @UseGuards(GitHubAuthGuard)
  @ApiExcludeEndpoint()
  async githubCallback(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.finishOAuth(req, res);
  }

  private async finishOAuth(req: Request, res: Response): Promise<void> {
    const user = req.user as OAuthUser | undefined;
    if (!user?.userId) throw new UnauthorizedException({ code: 'OAUTH_FAILED' });
    this.redirectAfterOAuth(
      res,
      await this.auth.issueSession(user.userId, sessionContext(req), preferredOrg(req)),
    );
  }
}
