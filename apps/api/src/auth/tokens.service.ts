import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { parseDurationSec } from './duration';

/**
 * Two audiences on one secret. `sl_access` and `sl_session` are both httpOnly cookies on
 * the API origin, so without an audience claim a share-link visitor's cookie would
 * verify as an access token and vice versa. The audience is checked on verify, so
 * neither can stand in for the other.
 */
export const JWT_AUDIENCE = {
  access: 'sl_access',
  shareSession: 'sl_session',
} as const;

export interface AccessClaims {
  readonly userId: string;
  /** `null` for a user who belongs to no organisation yet. See `subject.ts`. */
  readonly orgId: string | null;
}

/** Doc 05 §7.12's `ShareLinkSession`, decoded. */
export interface ShareSessionClaims {
  readonly shareLinkId: string;
  readonly projectId: string;
  readonly resourceId: string;
}

export interface SessionContext {
  readonly userAgent?: string | undefined;
  readonly ip?: string | undefined;
}

export interface IssuedRefreshToken {
  readonly refreshToken: string;
  readonly familyId: string;
  readonly expiresAt: Date;
  readonly userId: string;
}

/** The raw refresh token never touches the database — only this digest does. */
export function hashRefreshToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

const SHARE_SESSION_MAX_SEC = 12 * 3600;

@Injectable()
export class TokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  get accessTtlSec(): number {
    return parseDurationSec(this.config.get('ACCESS_TOKEN_TTL', { infer: true }));
  }

  get refreshTtlSec(): number {
    return parseDurationSec(this.config.get('REFRESH_TOKEN_TTL', { infer: true }));
  }

  private get accessSecret(): string {
    return this.config.get('JWT_ACCESS_SECRET', { infer: true });
  }

  // ---------------------------------------------------------------- access token

  issueAccessToken(claims: AccessClaims): Promise<string> {
    return this.jwt.signAsync(
      { org: claims.orgId },
      {
        subject: claims.userId,
        secret: this.accessSecret,
        expiresIn: this.accessTtlSec,
        audience: JWT_AUDIENCE.access,
      },
    );
  }

  async verifyAccessToken(token: string): Promise<AccessClaims | null> {
    const payload = await this.verifyJwt(token, JWT_AUDIENCE.access);
    if (!payload) return null;
    const userId = payload.sub;
    const org = payload.org;
    if (typeof userId !== 'string') return null;
    return { userId, orgId: typeof org === 'string' ? org : null };
  }

  // ------------------------------------------------- share-link session (§7.12)

  /**
   * Stateless, per doc 02 Key decision 9: there is no `sessions` row behind this cookie,
   * because `sessions.user_id` is NOT NULL and a share-link visitor has no user.
   * Revocation is the grant disappearing, not the cookie — §7.12 "Revocation, propagation".
   *
   * @param validUntil the link's own expiry, or null. Capped at 12 hours either way.
   */
  async issueShareSession(
    claims: ShareSessionClaims,
    validUntil: Date | null,
    now = new Date(),
  ): Promise<{ token: string; ttlSec: number }> {
    const remaining = validUntil
      ? Math.floor((validUntil.getTime() - now.getTime()) / 1000)
      : SHARE_SESSION_MAX_SEC;
    const ttlSec = Math.min(SHARE_SESSION_MAX_SEC, Math.max(remaining, 0));
    const token = await this.jwt.signAsync(
      { pid: claims.projectId, rid: claims.resourceId },
      {
        subject: `share_link:${claims.shareLinkId}`,
        secret: this.accessSecret,
        expiresIn: ttlSec,
        audience: JWT_AUDIENCE.shareSession,
      },
    );
    return { token, ttlSec };
  }

  async verifyShareSession(token: string): Promise<ShareSessionClaims | null> {
    const payload = await this.verifyJwt(token, JWT_AUDIENCE.shareSession);
    if (!payload) return null;
    const sub = payload.sub;
    const pid = payload.pid;
    const rid = payload.rid;
    if (typeof sub !== 'string' || typeof pid !== 'string' || typeof rid !== 'string') return null;
    const shareLinkId = sub.startsWith('share_link:') ? sub.slice('share_link:'.length) : '';
    return shareLinkId ? { shareLinkId, projectId: pid, resourceId: rid } : null;
  }

  private async verifyJwt(
    token: string,
    audience: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      return await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        secret: this.accessSecret,
        audience,
      });
    } catch {
      // Expired, tampered, or minted for the other audience. All the same answer.
      return null;
    }
  }

  // --------------------------------------------------------------- refresh family

  /** First login on a device: a new family. Every later rotation keeps this `familyId`. */
  async startSession(userId: string, ctx: SessionContext = {}): Promise<IssuedRefreshToken> {
    const refreshToken = randomBytes(32).toString('base64url');
    const familyId = randomUUID();
    const expiresAt = new Date(Date.now() + this.refreshTtlSec * 1000);
    await this.prisma.session.create({
      data: {
        userId,
        familyId,
        refreshTokenHash: hashRefreshToken(refreshToken),
        expiresAt,
        userAgent: ctx.userAgent ?? null,
        ip: ctx.ip ?? null,
      },
    });
    return { refreshToken, familyId, expiresAt, userId };
  }

  /**
   * Rotation with reuse detection — the security-critical path.
   *
   * A row whose `rotatedAt` is already set has been spent. Presenting it again means two
   * parties hold the same token, which means it leaked, and there is no way to tell the
   * victim from the thief. So the whole **family** dies: every unrevoked row sharing the
   * `familyId` is revoked and both parties are logged out. A rotated row is kept until it
   * expires precisely so this check has something to find.
   *
   * The `updateMany ... where rotatedAt: null` is the concurrency guard: two simultaneous
   * refreshes with the same token cannot both mint a successor. The loser gets a 401, and
   * if it retries with the spent token, the reuse branch above fires — which is the
   * correct reading, because at that point the token genuinely was used twice.
   */
  async rotate(rawToken: string, ctx: SessionContext = {}): Promise<IssuedRefreshToken> {
    const now = new Date();
    const row = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hashRefreshToken(rawToken) },
    });
    if (!row) throw new UnauthorizedException({ code: 'REFRESH_TOKEN_INVALID' });

    if (row.rotatedAt !== null) {
      await this.revokeFamily(row.familyId, now);
      throw new UnauthorizedException({ code: 'REFRESH_TOKEN_REUSED' });
    }
    if (row.revokedAt !== null || row.expiresAt.getTime() <= now.getTime()) {
      throw new UnauthorizedException({ code: 'REFRESH_TOKEN_INVALID' });
    }

    const refreshToken = randomBytes(32).toString('base64url');
    await this.prisma.$transaction(async (tx) => {
      const spent = await tx.session.updateMany({
        where: { id: row.id, rotatedAt: null, revokedAt: null },
        data: { rotatedAt: now, lastUsedAt: now },
      });
      if (spent.count !== 1) throw new UnauthorizedException({ code: 'REFRESH_TOKEN_INVALID' });
      await tx.session.create({
        data: {
          userId: row.userId,
          familyId: row.familyId,
          refreshTokenHash: hashRefreshToken(refreshToken),
          // Absolute family lifetime, not a sliding one: a stolen family cannot be kept
          // alive forever by refreshing it every fifteen minutes.
          expiresAt: row.expiresAt,
          userAgent: ctx.userAgent ?? null,
          ip: ctx.ip ?? null,
        },
      });
    });

    return { refreshToken, familyId: row.familyId, expiresAt: row.expiresAt, userId: row.userId };
  }

  async revokeFamily(familyId: string, now = new Date()): Promise<void> {
    await this.prisma.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  /** Logout. Kills the device, not the account — other families survive. */
  async revokeByRefreshToken(rawToken: string): Promise<void> {
    const row = await this.prisma.session.findUnique({
      where: { refreshTokenHash: hashRefreshToken(rawToken) },
      select: { familyId: true },
    });
    if (row) await this.revokeFamily(row.familyId);
  }

  /** Password reset and, in Phase 3, "log out other devices". */
  async revokeAllForUser(userId: string, now = new Date()): Promise<void> {
    await this.prisma.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now },
    });
  }
}
