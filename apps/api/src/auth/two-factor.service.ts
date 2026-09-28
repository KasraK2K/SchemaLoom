import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import type { AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_RATELIMIT } from '../redis/redis.tokens';
import { verifyPassword } from './password';
import type { SessionContext } from './tokens.service';
import {
  base32Encode,
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
  newRecoveryCode,
  newTotpSecret,
  otpauthUri,
  verifyTotp,
} from './totp';

const RECOVERY_CODE_COUNT = 10;

/** Every second-factor check a user makes, from any route. Fails closed like share unlock. */
const PER_USER = { limit: 10, windowSec: 15 * 60 };
/** One challenge cookie gets this many guesses; then the first factor is owed again. */
export const PER_CHALLENGE = { limit: 5, windowSec: 5 * 60 };

/**
 * TOTP enrolment and the second-factor check. The login gate itself is in
 * `AuthService.issueSession`; this service only answers "is this code right".
 *
 * A TOTP code is six digits; anything else is tried as a recovery code.
 */
@Injectable()
export class TwoFactorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    @Inject(REDIS_RATELIMIT) private readonly rateLimit: Redis,
  ) {}

  private get key(): string {
    return this.config.get('SECRETS_ENCRYPTION_KEY', { infer: true });
  }

  /**
   * Starts (or restarts) enrolment. The secret is stored unconfirmed, so it gates
   * nothing until `confirm` proves the authenticator app has it. QR rendering is the
   * client's business; the URI and the base32 secret are both returned.
   */
  async enrol(userId: string): Promise<{ secret: string; otpauthUri: string }> {
    const user = await this.user(userId);
    if (user.totpConfirmedAt !== null) throw new ConflictException({ code: 'TOTP_ALREADY_ENABLED' });
    const secret = newTotpSecret();
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: encryptSecret(secret, this.key) },
    });
    return { secret: base32Encode(secret), otpauthUri: otpauthUri(user.email, secret) };
  }

  /** Returns the recovery codes — the only time they exist in plaintext. */
  async confirm(userId: string, code: string, ctx: SessionContext): Promise<string[]> {
    const user = await this.user(userId);
    if (user.totpConfirmedAt !== null) throw new ConflictException({ code: 'TOTP_ALREADY_ENABLED' });
    if (user.totpSecret === null) throw new BadRequestException({ code: 'TOTP_NOT_ENROLLED' });
    await this.throttle(`mfa:user:${userId}`, PER_USER);
    if (!(await this.checkTotp(userId, user.totpSecret, code))) {
      throw new BadRequestException({ code: 'INVALID_CODE' });
    }
    const codes = newCodes();
    await this.prisma.$transaction(async (tx) => {
      const confirmed = await tx.user.updateMany({
        where: { id: userId, totpConfirmedAt: null, totpSecret: user.totpSecret },
        data: { totpConfirmedAt: new Date() },
      });
      if (confirmed.count !== 1) throw new ConflictException({ code: 'TOTP_ALREADY_ENABLED' });
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.recoveryCode.createMany({
        data: codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })),
      });
      await tx.auditLog.create({ data: audit(user, 'user.2fa_enabled', ctx) });
    });
    return codes;
  }

  /**
   * Needs a current code (TOTP or recovery) or the password. A stolen access token
   * alone must not be able to strip the second factor off the account.
   */
  async disable(
    userId: string,
    proof: { code?: string | undefined; password?: string | undefined },
    ctx: SessionContext,
  ): Promise<void> {
    const user = await this.user(userId);
    if (user.totpConfirmedAt === null) throw new BadRequestException({ code: 'TOTP_NOT_ENABLED' });
    let ok = false;
    if (proof.code !== undefined) {
      ok = await this.verifySecondFactor(userId, proof.code);
    } else if (proof.password !== undefined && user.passwordHash !== null) {
      await this.throttle(`mfa:user:${userId}`, PER_USER);
      ok = await verifyPassword(user.passwordHash, proof.password);
    }
    if (!ok) throw new BadRequestException({ code: 'INVALID_CODE' });
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { totpSecret: null, totpConfirmedAt: null },
      }),
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
      this.prisma.auditLog.create({ data: audit(user, 'user.2fa_disabled', ctx) }),
    ]);
  }

  /** Invalidates every earlier code. Needs a current TOTP or recovery code. */
  async regenerateRecoveryCodes(userId: string, code: string): Promise<string[]> {
    const user = await this.user(userId);
    if (user.totpConfirmedAt === null) throw new BadRequestException({ code: 'TOTP_NOT_ENABLED' });
    if (!(await this.verifySecondFactor(userId, code))) {
      throw new BadRequestException({ code: 'INVALID_CODE' });
    }
    const codes = newCodes();
    await this.prisma.$transaction([
      this.prisma.recoveryCode.deleteMany({ where: { userId } }),
      this.prisma.recoveryCode.createMany({
        data: codes.map((c) => ({ userId, codeHash: hashRecoveryCode(c) })),
      }),
    ]);
    return codes;
  }

  /** A TOTP code (not replayed), or an unused recovery code, which this spends. */
  async verifySecondFactor(userId: string, code: string): Promise<boolean> {
    await this.throttle(`mfa:user:${userId}`, PER_USER);
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed)) {
      const user = await this.user(userId);
      return user.totpSecret !== null && this.checkTotp(userId, user.totpSecret, trimmed);
    }
    const hit = await this.prisma.recoveryCode.findFirst({
      where: { userId, codeHash: hashRecoveryCode(trimmed), usedAt: null },
      select: { id: true },
    });
    if (!hit) return false;
    // Same single-use shape as `VerificationService.consume`: the conditional update is
    // the guard, so two concurrent submissions of one code cannot both pass.
    const spent = await this.prisma.recoveryCode.updateMany({
      where: { id: hit.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    return spent.count === 1;
  }

  /** Fails closed (redis.tokens.ts): a Redis error propagates, it never admits. */
  async throttle(key: string, rule: { limit: number; windowSec: number }): Promise<void> {
    const count = await this.rateLimit.incr(key);
    if (count === 1) await this.rateLimit.expire(key, rule.windowSec);
    if (count > rule.limit) {
      throw new HttpException({ code: 'rate_limited' }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  /**
   * A code is good for one use: the matched step is claimed with `SET NX`, so the same
   * six digits read over a shoulder cannot be replayed inside their 90-second window.
   */
  private async checkTotp(userId: string, encrypted: string, code: string): Promise<boolean> {
    const step = verifyTotp(decryptSecret(encrypted, this.key), code);
    if (step === null) return false;
    const claimed = await this.rateLimit.set(`totp:used:${userId}:${String(step)}`, '1', 'EX', 120, 'NX');
    return claimed === 'OK';
  }

  private async user(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        totpSecret: true,
        totpConfirmedAt: true,
      },
    });
    if (!user) throw new BadRequestException({ code: 'USER_NOT_FOUND' });
    return user;
  }
}

function newCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
}

function audit(user: { id: string; email: string }, action: string, ctx: SessionContext) {
  return {
    actorUserId: user.id,
    actorEmail: user.email,
    action,
    resourceType: 'user',
    resourceId: user.id,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
  };
}
