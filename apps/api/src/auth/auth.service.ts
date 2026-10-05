import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  Injectable,
  UnauthorizedException,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readAppearance, type Appearance } from '@schemaloom/contracts';
import { VerificationPurpose } from '../generated/prisma/enums';
import type { AppEnv } from '../config/env';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { issueCsrfToken } from './csrf';
import { applyOrgAppearance } from './org-appearance';
import { SignupPolicy, hashInviteToken } from './signup-policy';
import { enforcedConnectionFor } from './sso.service';
import { burnPasswordTime, hashPassword, verifyPassword } from './password';
import { TokensService, type SessionContext } from './tokens.service';
import { PER_CHALLENGE, TwoFactorService } from './two-factor.service';
import { VerificationService } from './verification.service';

/**
 * Per address, per purpose, for the three unauthenticated routes that send email. Keyed
 * on the address alone and checked BEFORE the account lookup, so a 429 says nothing about
 * whether the account exists. Stops one address being flooded, not one IP mailing many.
 */
const EMAILS_PER_ADDRESS = { limit: 5, windowSec: 60 * 60 };

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

/** First factor proven, second owed: the controller sets `sl_mfa` instead of the session. */
export interface MfaChallenge {
  readonly mfaChallenge: string;
}

export type LoginOutcome = SessionBundle | MfaChallenge;

export function isMfaChallenge(outcome: LoginOutcome): outcome is MfaChallenge {
  return 'mfaChallenge' in outcome;
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
  /** Theme, colour variant and mode, read back through the contract (defaults when unknown). */
  readonly appearance: Appearance;
  readonly emailVerified: boolean;
  readonly twoFactorEnabled: boolean;
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
    private readonly twoFactor: TwoFactorService,
    private readonly signup: SignupPolicy,
  ) {}

  /** Fails the boot rather than the first login when a TTL string is malformed. */
  onModuleInit(): void {
    const lifetimes = [this.tokens.accessTtlSec, this.tokens.refreshTtlSec];
    if (lifetimes.some((ttl) => ttl <= 0)) {
      throw new Error('ACCESS_TOKEN_TTL and REFRESH_TOKEN_TTL must be positive durations');
    }
  }

  // ------------------------------------------------------------------ sessions

  /**
   * THE login gate. Password, magic link, Google, GitHub and registration all end here,
   * so this is the one place that can refuse to hand a 2FA user a session on their first
   * factor alone. They get a 5-minute challenge instead, and `completeMfa` — the only
   * other caller of `openSession` — trades it plus a code for the real thing.
   */
  async issueSession(
    userId: string,
    ctx: SessionContext,
    preferredOrgId?: string,
  ): Promise<LoginOutcome> {
    // Roadmap 14 §1.3: an org that enforces SSO refuses every other way in for its members
    // (owners excepted). Only `openSsoSession` skips this, and it never comes through here.
    const required = await enforcedConnectionFor(this.prisma, userId);
    if (required !== null)
      throw new ForbiddenException({
        code: 'sso_required',
        connectionId: required.id,
        connectionName: required.name,
      });
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { totpConfirmedAt: true },
    });
    if (user?.totpConfirmedAt) return { mfaChallenge: await this.tokens.issueMfaChallenge(userId) };
    return this.openSession(userId, ctx, preferredOrgId);
  }

  /**
   * Roadmap 14 §1.3 — an SSO sign-in. No enforcement check (this IS the enforced path) and no
   * TOTP challenge (Q5: the IdP owns MFA). The session opens in the connection's org.
   */
  openSsoSession(userId: string, ctx: SessionContext, orgId: string): Promise<SessionBundle> {
    return this.openSession(userId, { ...ctx, method: 'sso' }, orgId);
  }

  /** `POST /auth/2fa/verify`. Five guesses per challenge, then the first factor is owed again. */
  async completeMfa(
    challengeToken: string,
    code: string,
    ctx: SessionContext,
    preferredOrgId?: string,
  ): Promise<SessionBundle> {
    const challenge = await this.tokens.verifyMfaChallenge(challengeToken);
    if (!challenge) throw new UnauthorizedException({ code: 'MFA_CHALLENGE_INVALID' });
    await this.twoFactor.throttle(`mfa:challenge:${challenge.challengeId}`, PER_CHALLENGE);
    if (!(await this.twoFactor.verifySecondFactor(challenge.userId, code))) {
      throw new BadRequestException({ code: 'INVALID_CODE' });
    }
    return this.openSession(challenge.userId, ctx, preferredOrgId);
  }

  private async openSession(
    userId: string,
    ctx: SessionContext,
    preferredOrgId?: string,
  ): Promise<SessionBundle> {
    const orgId = await this.resolveOrgId(userId, preferredOrgId);
    const issued = await this.tokens.startSession(userId, ctx);
    // Roadmap 14: who signed in, how, from where; filed under the org the session opens in.
    await this.prisma.auditLog.create({
      data: {
        organizationId: orgId,
        actorUserId: userId,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: userId,
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null,
        metadata: { method: ctx.method ?? 'unknown' },
      },
    });
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

  /** With an invitation token the address is already proven, so no verification email. */
  async register(input: {
    email: string;
    password: string;
    name: string;
    inviteToken?: string;
  }): Promise<string> {
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password);
    let created: { id: string; verified: boolean };
    try {
      created = await this.signup.createUser(
        email,
        { inviteToken: input.inviteToken, emailProven: false },
        async (tx, verified) => {
          const user = await tx.user.create({
            data: {
              email,
              name: input.name.trim(),
              passwordHash,
              emailVerifiedAt: verified ? new Date() : null,
            },
            select: { id: true },
          });
          // `verified` means the token named a live invitation, so it names the org.
          if (verified && input.inviteToken !== undefined) {
            const invite = await tx.invitation.findUnique({
              where: { tokenHash: hashInviteToken(input.inviteToken) },
              select: { organizationId: true },
            });
            if (invite !== null) await applyOrgAppearance(tx, user.id, invite.organizationId);
          }
          return { id: user.id, verified };
        },
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictException({ code: 'EMAIL_TAKEN' });
      throw error;
    }
    if (!created.verified) await this.sendVerification(created.id, email, input.name.trim());
    return created.id;
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

  private throttleEmail(purpose: 'verify' | 'reset' | 'magic', email: string): Promise<void> {
    return this.twoFactor.throttle(`email:${purpose}:${email}`, EMAILS_PER_ADDRESS);
  }

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
    await this.throttleEmail('verify', email);
    const user = await this.prisma.user.findFirst({
      where: { email, emailVerifiedAt: null },
      select: { id: true, name: true },
    });
    if (user) await this.sendVerification(user.id, email, user.name);
  }

  async verifyEmail(token: string): Promise<void> {
    const consumed = await this.verification.consume(token, VerificationPurpose.email_verification);
    if (!consumed.userId) return;
    await this.prisma.user.updateMany({
      where: { id: consumed.userId, emailVerifiedAt: null },
      data: { emailVerifiedAt: new Date() },
    });
  }

  // ----------------------------------------------------------- password reset

  async requestPasswordReset(rawEmail: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    await this.throttleEmail('reset', email);
    const user = await this.prisma.user.findFirst({
      where: { email },
      select: { id: true, name: true },
    });
    if (!user) return;
    const token = await this.verification.issue(VerificationPurpose.password_reset, email, user.id);
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

  // --------------------------------------------------------------- magic link

  /**
   * Always 202 at the controller. An unknown address still gets a link: consuming it
   * proves the mailbox, which is all a magic-link account is. Whether mail was sent to
   * an existing account or a new one is not this route's to tell.
   */
  async requestMagicLink(rawEmail: string, next?: string): Promise<void> {
    const email = normalizeEmail(rawEmail);
    await this.throttleEmail('magic', email);
    const user = await this.prisma.user.findFirst({ where: { email }, select: { id: true } });
    const token = await this.verification.issue(
      VerificationPurpose.magic_link,
      email,
      user?.id ?? null,
    );
    await this.mail.sendMagicLinkEmail(email, token, next);
  }

  /** Returns the user to open a session for. The link proves the address, so it verifies it. */
  async consumeMagicLink(token: string): Promise<string> {
    const consumed = await this.verification.consume(token, VerificationPurpose.magic_link);
    const now = new Date();
    if (consumed.userId) {
      await this.prisma.user.updateMany({
        where: { id: consumed.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      return consumed.userId;
    }
    // Issued to an address with no account. One may have been registered since.
    const existing = await this.prisma.user.findFirst({
      where: { email: consumed.email },
      select: { id: true, emailVerifiedAt: true },
    });
    if (existing) {
      if (existing.emailVerifiedAt === null) {
        await this.prisma.user.update({
          where: { id: existing.id },
          data: { emailVerifiedAt: now },
        });
      }
      return existing.id;
    }
    try {
      const created = await this.signup.createUser(consumed.email, { emailProven: true }, (tx) =>
        tx.user.create({
          data: {
            email: consumed.email,
            name: consumed.email.split('@')[0] ?? consumed.email,
            emailVerifiedAt: now,
          },
          select: { id: true },
        }),
      );
      return created.id;
    } catch (error) {
      // Registered between the read and the write — the token was single-use, so this
      // is the same person racing themselves. Their account wins.
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.prisma.user.findFirst({
        where: { email: consumed.email },
        select: { id: true },
      });
      if (!raced) throw error;
      return raced.id;
    }
  }

  // ------------------------------------------------------------------- oauth

  /**
   * Account linking by verified email. Google asserts `email_verified` and GitHub marks
   * each address `verified`; both strategies refuse a profile without one, so this can
   * never attach an OAuth identity to a SchemaLoom account whose address the OAuth user
   * has not proven they own.
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
        await this.signup.createUser(email, { emailProven: profile.emailVerified }, (tx) =>
          tx.user.create({
            data: {
              email,
              name: profile.name,
              avatarUrl: profile.avatarUrl,
              emailVerifiedAt: profile.emailVerified ? new Date() : null,
            },
            select: { id: true },
          }),
        )
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
        uiTheme: true,
        uiVariant: true,
        emailVerifiedAt: true,
        totpConfirmedAt: true,
      },
    });
    if (!user) throw new UnauthorizedException({ code: 'USER_NOT_FOUND' });
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      theme: user.theme,
      appearance: readAppearance({
        theme: user.uiTheme,
        variant: user.uiVariant,
        mode: user.theme,
      }),
      emailVerified: user.emailVerifiedAt !== null,
      twoFactorEnabled: user.totpConfirmedAt !== null,
      organizationId: await this.resolveOrgId(user.id),
    };
  }

  /** The caller's appearance. Validated by the DTO; the mode is the existing `theme` column. */
  async setAppearance(userId: string, appearance: Appearance): Promise<Appearance> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { uiTheme: appearance.theme, uiVariant: appearance.variant, theme: appearance.mode },
    });
    return appearance;
  }
}
