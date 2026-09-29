import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, type Profile } from 'passport-github2';
import type { AppEnv } from '../config/env';
import { AuthService } from './auth.service';
import type { OAuthUser } from './google.strategy';

export const GITHUB_STRATEGY = 'GITHUB_STRATEGY';

/** One entry of GitHub's `/user/emails`, as passport-github2 passes it with `allRawEmails`. */
interface GitHubEmail {
  readonly value: string;
  readonly primary?: boolean;
  readonly verified?: boolean;
}

export function githubCallbackUrl(apiPublicUrl: string): string {
  return `${apiPublicUrl.replace(/\/+$/, '')}/api/auth/github/callback`;
}

/**
 * The PRIMARY address, and only if GitHub has verified it. `/user/emails` lists every
 * address on the account, verified or not — linking by any of them would let someone
 * add a victim's address to their own GitHub account and walk into the matching
 * SchemaLoom account.
 */
export function verifiedPrimaryEmail(profile: Profile): string | null {
  const emails = (profile.emails ?? []) as readonly GitHubEmail[];
  const primary = emails.find((e) => e.primary === true && e.verified === true);
  return primary?.value ?? null;
}

@Injectable()
export class GitHubStrategy extends PassportStrategy(Strategy, 'github') {
  constructor(
    config: ConfigService<AppEnv, true>,
    private readonly auth: AuthService,
  ) {
    // Annotated locals, as in `GoogleStrategy`.
    const clientID: string | undefined = config.get('GITHUB_CLIENT_ID', { infer: true });
    const clientSecret: string | undefined = config.get('GITHUB_CLIENT_SECRET', { infer: true });
    const apiPublicUrl: string = config.get('API_PUBLIC_URL', { infer: true });
    super({
      clientID: clientID ?? '',
      clientSecret: clientSecret ?? '',
      callbackURL: githubCallbackUrl(apiPublicUrl),
      scope: ['user:email'],
      // Without this passport-github2 keeps only the primary address and drops the
      // `verified` flag, which is the one field this strategy exists to check.
      allRawEmails: true,
    });
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
  ): Promise<OAuthUser> {
    const email = verifiedPrimaryEmail(profile);
    if (!email) throw new UnauthorizedException({ code: 'OAUTH_EMAIL_UNVERIFIED' });
    const userId = await this.auth.upsertOAuthUser({
      provider: 'github',
      providerAccountId: profile.id,
      email,
      // `||`, not `??`: GitHub sends an empty display name for accounts that never set one.
      // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
      name: profile.displayName || profile.username || email,
      avatarUrl: profile.photos?.[0]?.value ?? null,
      emailVerified: true,
    });
    return { userId };
  }
}

/** Same mechanism as `googleStrategyProvider`: absent credentials, absent strategy. */
export const githubStrategyProvider = {
  provide: GITHUB_STRATEGY,
  inject: [ConfigService, AuthService],
  useFactory: (config: ConfigService<AppEnv, true>, auth: AuthService): GitHubStrategy | null =>
    isGitHubConfigured(config) ? new GitHubStrategy(config, auth) : null,
};

export function isGitHubConfigured(config: ConfigService<AppEnv, true>): boolean {
  const id: string | undefined = config.get('GITHUB_CLIENT_ID', { infer: true });
  const secret: string | undefined = config.get('GITHUB_CLIENT_SECRET', { infer: true });
  return Boolean(id) && Boolean(secret);
}
