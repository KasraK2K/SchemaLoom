import {
  ConflictException,
  NotFoundException,
  Injectable,
  UnauthorizedException,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VerificationPurpose } from '../generated/prisma/enums';
import type { AppEnv } from '../config/env';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { issueCsrfToken } from './csrf';
import { burnPasswordTime, hashPassword, verifyPassword } from './password';
import { TokensService, type SessionContext } from './tokens.service';
import { VerificationService } from './verification.service';

/** Uniqueness is `users_email_uq ON users (lower(email))`; normalise-on-write is the convenience. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/** Everything the controller needs to write the four user cookies. */
export interface SessionBundle {
  readonly userId: string;
  readonly orgId: string | null;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly csrfToken: string;
  readonly accessTtlSec: number;
  readonly refreshTtlSec: number;
}

export interface OAuthProfile {
  readonly provider: string;
  readonly providerAccountId: string;
  readonly email: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly emailVerified: boolean;
}

export interface MeResponse {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly theme: string;
  readonly emailVerified: boolean;
  readonly organizationId: string | null;
}

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    private readonly verification: VerificationService,
    private readonly mail: MailService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  /** Fails the boot rather than the first login when a TTL string is malformed. */
  onModuleInit(): void {
    const lifetimes = [this.tokens.accessTtlSec, this.tokens.refreshTtlSec];
    if (lifetimes.some((ttl) => ttl <= 0)) {
      throw new Error('ACCESS_TOKEN_TTL and REFRESH_TOKEN_TTL must be positive durations');
    }
  }

  // ------------------------------------------------------------------ sessions

  async issueSession(
    userId: string,
    ctx: SessionContext,
    preferredOrgId?: string,
  ): Promise<SessionBundle> {
    const orgId = await this.resolveOrgId(userId, preferredOrgId);
    const issued = await this.tokens.startSession(userId, ctx);
    return this.bundle(userId, orgId, issued.refreshToken, issued.expiresAt);
  }

  /** `POST /auth/refresh`. Reuse detection lives in `TokensService.rotate`. */
  async refresh(
    rawRefreshToken: string,
    ctx: SessionContext,
    preferredOrgId?: string,
  ): Promise<SessionBundle> {
    const rotated = await this.tokens.rotate(rawRefreshToken, ctx);
    const orgId = await this.resolveOrgId(rotated.userId, preferredOrgId);
    return this.bundle(rotated.userId, orgId, rotated.refreshToken, rotated.expiresAt);
  }

  private async bundle(
    userId: string,
    orgId: string | null,
    refreshToken: string,
    expiresAt: Date,
  ): Promise<SessionBundle> {
    const accessToken = await this.tokens.issueAccessToken({ userId, orgId });
    return {
      userId,
      orgId,
      accessToken,
      refreshToken,
      csrfToken: issueCsrfToken(this.config.get('CSRF_SECRET', { infer: true })),
      accessTtlSec: this.tokens.accessTtlSec,
      // The family's expiry is absolute, so the cookie tracks what is left of it rather
      // than restating REFRESH_TOKEN_TTL and outliving the row behind it.
      refreshTtlSec: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
    };
  }

  /**
   * The active organisation: the one `sl_org` prefers if the user is still a member of
   * it, otherwise their first membership. Everything downstream reads `orgId` off the
   * access token, not off this call.
   */
  async resolveOrgId(userId: string, preferredOrgId?: string): Promise<string | null> {
    if (preferredOrgId !== undefined && (await this.isMember(userId, preferredOrgId))) {
      return preferredOrgId;
    }
    const membership = await this.prisma.orgMember.findFirst({
      where: { userId },
      orderBy: { joinedAt: 'asc' },
      select: { organizationId: true },
    });
    return membership?.organizationId ?? null;
  }

  /**
   * `POST /auth/switch-org` — a fresh access token for another org the user belongs to.
   * The refresh token is NOT rotated: the device and its family are unchanged, only the
   * `org` claim is. A non-member gets the same 404 as an org that does not exist.
   */
  async switchOrg(
    userId: string,
    organizationId: string,
  ): Promise<{ accessToken: string; accessTtlSec: number }> {
    if (!(await this.isMember(userId, organizationId))) {
      throw new NotFoundException({ code: 'not_found' });
    }
    return {
      accessToken: await this.tokens.issueAccessToken({ userId, orgId: organizationId }),
      accessTtlSec: this.tokens.accessTtlSec,
    };
  }

  private async isMember(userId: string, organizationId: string): Promise<boolean> {
    const row = await this.prisma.orgMember.findFirst({
      where: { userId, organizationId, organization: { deletedAt: null } },
      select: { organizationId: true },
    });
    return row !== null;
  }

  // ------------------------------------------------------------ password auth

  async register(input: { email: string; password: string; name: string }): Promise<string> {
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    let userId: string;
    try {
      const user = await this.prisma.user.create({
        data: { email, name: input.name.trim(), passwordHash },
        select: { id: true },
      });
      userId = user.id;
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException({ code: 'EMAIL_TAKEN' });
      throw error;
    }
    await this.sendVerification(userId, email, input.name.trim());
    return userId;
  }

  /**
   * One uniform failure for "no such user", "OAuth-only account" and "wrong password".
   * The `burnPasswordTime` branch keeps the timing uniform too — without it, an
   * unknown address answers in a millisecond and a known one in fifty.
   */
  async login(input: { email: string; password: string }): Promise<string> {
    const email = normalizeEmail(input.email);
    const user = await this.prisma.user.findFirst({
      where: { email },
      select: { id: true, passwordHash: true },
    });
    const rejected = new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });
    if (!user?.passwordHash) {
      await burnPasswordTime(input.password);
      throw rejected;
    }
    if (!(await verifyPassword(user.passwordHash, input.password))) throw rejected;
    return user.id;
  }

  // ------------------------------------------------------- email verification

  private async sendVerification(userId: string, email: string, name: string): Promise<void> {
    const token = await this.verification.issue(
      VerificationPurpose.email_verification,
      email,
      userId,
    );
    await this.mail.sendVerificationEmail(email, name, token);
  }

  /** Always 204 at the controller: whether the address exists is not this route's to tell. */
  async resendVerification(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const user = await this.prisma.user.findFirst({
      where: { email, emailVerifiedAt: null },
      select: { id: true, name: true },
    });
    if (user) await this.sendVerification(user.id, email, user.name);
  }

  async verifyEmail(token: string): Promise<void> {
    const consumed = await this.verification.consume(
      token,
      VerificationPurpose.email_verification,
    );
    if (!consumed.userId) return;
    await this.prisma.user.updateMany({
      where: { id: consumed.userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
  }

  // ----------------------------------------------------------- password reset

  async requestPasswordReset(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    const user = await this.prisma.user.findFirst({
      where: { email },
      select: { id: true, name: true },
    });
    if (!user) return;
    const token = await this.verification.issue(
      VerificationPurpose.password_reset,
      email,
      user.id,
    );
    await this.mail.sendPasswordResetEmail(email, user.name, token);
  }

  /**
   * Resetting a password revokes every session the user has. Anything else leaves the
   * attacker who prompted the reset still logged in on their own device.
   */
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const consumed = await this.verification.consume(token, VerificationPurpose.password_reset);
    if (!consumed.userId) throw new UnauthorizedException({ code: 'TOKEN_INVALID' });
    const passwordHash = await hashPassword(newPassword);
    await this.prisma.user.update({
      where: { id: consumed.userId },
      // A password reset proves control of the mailbox, so it verifies the address too.
      data: { passwordHash, emailVerifiedAt: new Date() },
    });
    await this.tokens.revokeAllForUser(consumed.userId);
  }

  // ------------------------------------------------------------------- oauth

  /**
   * Account linking by verified email. Google asserts `email_verified`; the strategy
   * refuses the profile without it, so this can never attach a Google identity to a
   * SchemaLoom account whose address the OAuth user has not proven they own.
   */
  async upsertOAuthUser(profile: OAuthProfile): Promise<string> {
    const email = normalizeEmail(profile.email);
    const existing = await this.prisma.account.findUnique({
      where: {
        provider_providerAccountId: {
          provider: profile.provider,
          providerAccountId: profile.providerAccountId,
        },
      },
      select: { userId: true },
    });
    if (existing) return existing.userId;

    const byEmail = await this.prisma.user.findFirst({ where: { email }, select: { id: true } });
    const userId =
      byEmail?.id ??
      (
        await this.prisma.user.create({
          data: {
            email,
            name: profile.name,
            avatarUrl: profile.avatarUrl,
            emailVerifiedAt: profile.emailVerified ? new Date() : null,
          },
          select: { id: true },
        })
      ).id;

    await this.prisma.account.create({
      data: {
        userId,
        provider: profile.provider,
        providerAccountId: profile.providerAccountId,
      },
    });
    return userId;
  }

  // -------------------------------------------------------------------- me

  async me(userId: string): Promise<MeResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        theme: true,
        emailVerifiedAt: true,
      },
    });
    if (!user) throw new UnauthorizedException({ code: 'USER_NOT_FOUND' });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      theme: user.theme,
      emailVerified: user.emailVerifiedAt !== null,
      organizationId: await this.resolveOrgId(user.id),
    };
  }
}
