import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { TokensService } from '../auth';
import { verifyPassword } from '../auth/password';
import { PrincipalType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_RATELIMIT } from '../redis/redis.tokens';
import { hashShareToken } from './share-links.service';

/** §7.12 step 2 — 5 attempts per minute per IP, 20 per hour per link. */
const PER_IP = { limit: 5, windowSec: 60 };
const PER_LINK = { limit: 20, windowSec: 3600 };

export interface Unlocked {
  readonly projectId: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly session: { token: string; ttlSec: number };
}

/**
 * Doc 05 §7.12 "Flow" and §12.2(a) — turning a URL token into an `sl_session`.
 *
 * Every dead end is the SAME 404: unknown token, revoked, expired, a link whose grant is
 * gone, a soft-deleted project. "This link expired" would be an oracle for token
 * guessing. The page this backs therefore shows no project or org name either — those
 * are names, and the visitor has not proved anything yet.
 */
@Injectable()
export class ShareLinkRedeemService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokensService,
    @Inject(REDIS_RATELIMIT) private readonly rateLimit: Redis,
  ) {}

  /** `GET /s/:token` — does it exist, and does it want a password. No side effects. */
  async inspect(token: string): Promise<{ needsPassword: boolean }> {
    const link = await this.live(token);
    return { needsPassword: link.passwordHash !== null };
  }

  /** `POST /s/:token/unlock` — the one unsafe unauthenticated route; rate-limited instead of CSRF'd. */
  async unlock(token: string, password: string | null, ip: string | undefined): Promise<Unlocked> {
    const link = await this.live(token);
    await this.throttle(`share-unlock:ip:${ip ?? 'unknown'}`, PER_IP);
    await this.throttle(`share-unlock:link:${link.id}`, PER_LINK);

    if (link.passwordHash !== null) {
      const ok = password !== null && (await verifyPassword(link.passwordHash, password));
      if (!ok) throw new UnauthorizedException({ code: 'unlock_failed' });
    }

    const session = await this.tokens.issueShareSession(
      { shareLinkId: link.id, projectId: link.projectId, resourceId: link.grant.resourceId },
      link.expiresAt,
    );

    // §7.12 step 3: off the critical path. A share link is one hot row, and an
    // in-request counter bump would serialise every visitor behind its lock.
    void this.prisma
      .$transaction([
        this.prisma.shareLink.update({
          where: { id: link.id },
          data: { accessCount: { increment: 1 }, lastAccessedAt: new Date() },
        }),
        this.prisma.auditLog.create({
          data: {
            organizationId: link.project.organizationId,
            projectId: link.projectId,
            action: 'share_link.unlocked',
            resourceType: link.grant.resourceType,
            resourceId: link.grant.resourceId,
            ip: ip ?? null,
            metadata: { shareLinkId: link.id },
          },
        }),
      ])
      .catch(() => undefined);

    return {
      projectId: link.projectId,
      resourceType: link.grant.resourceType,
      resourceId: link.grant.resourceId,
      session,
    };
  }

  private async live(token: string) {
    const link = await this.prisma.shareLink.findUnique({
      where: { tokenHash: hashShareToken(token) },
      include: { project: { select: { organizationId: true, deletedAt: true } } },
    });
    const now = new Date();
    const alive =
      link !== null &&
      link.revokedAt === null &&
      (link.expiresAt === null || link.expiresAt > now) &&
      link.project.deletedAt === null;
    // R25: a link whose grant is gone would unlock into a project where every call 404s.
    const grant = alive
      ? await this.prisma.accessGrant.findFirst({
          where: { principalType: PrincipalType.share_link, principalId: link.id },
          select: { resourceType: true, resourceId: true },
        })
      : null;
    if (!alive || grant === null) throw new NotFoundException({ code: 'not_found' });
    return { ...link, grant };
  }

  /** Fails closed (redis.tokens.ts): a Redis error propagates, it never admits. */
  private async throttle(key: string, rule: { limit: number; windowSec: number }): Promise<void> {
    const count = await this.rateLimit.incr(key);
    if (count === 1) await this.rateLimit.expire(key, rule.windowSec);
    if (count > rule.limit) {
      throw new HttpException({ code: 'rate_limited' }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
