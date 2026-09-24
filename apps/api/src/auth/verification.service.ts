import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { VerificationPurpose } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

export const VERIFICATION_TTL_SEC = {
  [VerificationPurpose.email_verification]: 24 * 3600,
  [VerificationPurpose.password_reset]: 3600,
  [VerificationPurpose.magic_link]: 15 * 60,
  [VerificationPurpose.email_change]: 24 * 3600,
} as const satisfies Record<VerificationPurpose, number>;

export function hashVerificationToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export interface ConsumedToken {
  readonly userId: string | null;
  readonly email: string;
}

/**
 * One table for email verification, password reset, magic link and email change —
 * doc 02's reasoning, adopted: four tables with identical columns would be four tables
 * with identical bugs. Phase 1 issues two of the four purposes; the other two are named
 * here so the TTL table is complete when they land.
 */
@Injectable()
export class VerificationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the raw token, which is the only time it exists in plaintext. Issuing
   * consumes any outstanding token of the same purpose for the same address, so
   * requesting a second reset link cannot leave the first one live for an hour.
   */
  async issue(
    purpose: VerificationPurpose,
    email: string,
    userId: string | null,
    now = new Date(),
  ): Promise<string> {
    const raw = randomBytes(32).toString('base64url');
    await this.prisma.verificationToken.updateMany({
      where: { email, purpose, consumedAt: null },
      data: { consumedAt: now },
    });
    await this.prisma.verificationToken.create({
      data: {
        userId,
        email,
        purpose,
        tokenHash: hashVerificationToken(raw),
        expiresAt: new Date(now.getTime() + VERIFICATION_TTL_SEC[purpose] * 1000),
      },
    });
    return raw;
  }

  /**
   * Single use, enforced by the database rather than by the read that precedes it: the
   * `updateMany ... where consumedAt: null` either stamps exactly one row or the token
   * was already spent. A `findUnique` followed by an unconditional `update` would let
   * two concurrent requests — or one replayed one — both pass.
   */
  async consume(
    rawToken: string,
    purpose: VerificationPurpose,
    now = new Date(),
  ): Promise<ConsumedToken> {
    const invalid = new BadRequestException({ code: 'TOKEN_INVALID' });
    const row = await this.prisma.verificationToken.findUnique({
      where: { tokenHash: hashVerificationToken(rawToken) },
      select: { id: true, userId: true, email: true, purpose: true, expiresAt: true },
    });
    if (!row) throw invalid;
    if (row.purpose !== purpose || row.expiresAt.getTime() <= now.getTime()) throw invalid;

    const spent = await this.prisma.verificationToken.updateMany({
      where: { id: row.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (spent.count !== 1) throw invalid;

    return { userId: row.userId, email: row.email };
  }
}
