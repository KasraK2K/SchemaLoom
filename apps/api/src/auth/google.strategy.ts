import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type Profile } from 'passport-google-oauth20';
import type { AppEnv } from '../config/env';
import { AuthService } from './auth.service';

export const GOOGLE_STRATEGY = 'GOOGLE_STRATEGY';

/** What `validate` puts on `req.user`; the controller turns it into cookies. */
export interface OAuthUser {
  readonly userId: string;
}

export function googleCallbackUrl(apiPublicUrl: string): string {
  return `${apiPublicUrl.replace(/\/+$/, '')}/api/auth/google/callback`;
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor(
    config: ConfigService<AppEnv, true>,
    private readonly auth: AuthService,
  ) {
    // Annotated locals: `ConfigService.get` widens to `any` for this env shape, and the
    // strategy's own options are the one place that must not silently accept it.
    const clientID: string | undefined = config.get('GOOGLE_CLIENT_ID', { infer: true });
    const clientSecret: string | undefined = config.get('GOOGLE_CLIENT_SECRET', { infer: true });
    const apiPublicUrl: string = config.get('API_PUBLIC_URL', { infer: true });
    super({
      clientID: clientID ?? '',
      clientSecret: clientSecret ?? '',
      callbackURL: googleCallbackUrl(apiPublicUrl),
      scope: ['email', 'profile'],
    });
  }

  /**
   * An unverified Google address is refused outright. `upsertOAuthUser` links by email,
   * so accepting one would let anyone who can add an unverified address to a Google
   * account take over the matching SchemaLoom account.
   */
  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): Promise<OAuthUser> {
    const email = profile._json.email ?? profile.emails?.[0]?.value;
    const verified = profile._json.email_verified ?? profile.emails?.[0]?.verified ?? false;
    if (!email || !verified) {
      throw new UnauthorizedException({ code: 'OAUTH_EMAIL_UNVERIFIED' });
    }
    const userId = await this.auth.upsertOAuthUser({
      provider: 'google',
      providerAccountId: profile.id,
      email,
      name: profile._json.name ?? (profile.displayName || email),
      avatarUrl: profile._json.picture ?? null,
      emailVerified: true,
    });
    return { userId };
  }
}

/**
 * Registered only when both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are present
 * (`env.ts` already enforces both-or-neither). A factory that returns `null` is the
 * whole mechanism: `PassportStrategy` registers with passport from its *constructor*,
 * so a strategy that is never constructed is a strategy passport has never heard of —
 * and `GoogleAuthGuard` turns that into a 404 rather than a 500.
 *
 * Exported as a plain value so the "absent when unset" rule is testable without a
 * Nest container.
 */
export const googleStrategyProvider = {
  provide: GOOGLE_STRATEGY,
  inject: [ConfigService, AuthService],
  useFactory: (
    config: ConfigService<AppEnv, true>,
    auth: AuthService,
  ): GoogleStrategy | null =>
    isGoogleConfigured(config) ? new GoogleStrategy(config, auth) : null,
};

export function isGoogleConfigured(config: ConfigService<AppEnv, true>): boolean {
  const id: string | undefined = config.get('GOOGLE_CLIENT_ID', { infer: true });
  const secret: string | undefined = config.get('GOOGLE_CLIENT_SECRET', { infer: true });
  return Boolean(id) && Boolean(secret);
}
