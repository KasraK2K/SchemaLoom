import { randomBytes } from 'node:crypto';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_RATELIMIT } from '../redis/redis.tokens';
import { hashApiToken } from './api-token-auth.service';
import type { ScimPrincipal } from './subject';

export const SCIM_TOKEN_PREFIX = 'slscim_';

/** Per token. An initial Okta or Entra sync is bursty, so this is wider than an API token's. */
const RATE = { limit: 600, windowSec: 60 };
const LAST_USED_EVERY_MS = 60_000;

/** A fresh secret, and what is stored of it: the hash and the visible prefix. */
export function newScimToken(): { secret: string; tokenHash: string; prefix: string } {
  const secret = `${SCIM_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    secret,
    tokenHash: hashApiToken(secret),
    prefix: secret.slice(0, SCIM_TOKEN_PREFIX.length + 8),
  };
}

/**
 * Roadmap 14b §1.2 — `Bearer slscim_…` becomes its connection and org. Missing, revoked, a
 * deleted connection and a deleted org are the same 401. Rate-limited per token, failing
 * closed like `ApiTokenAuthService`.
 */
@Injectable()
export class ScimTokenAuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_RATELIMIT) private readonly rateLimit: Redis,
  ) {}

  async principalFor(secret: string | undefined): Promise<ScimPrincipal> {
    const row =
      secret?.startsWith(SCIM_TOKEN_PREFIX) === true
        ? await this.prisma.scimToken.findUnique({
            where: { tokenHash: hashApiToken(secret) },
            select: {
              id: true,
              revokedAt: true,
              lastUsedAt: true,
              connection: {
                select: {
                  id: true,
                  organizationId: true,
                  organization: { select: { deletedAt: true } },
                },
              },
            },
          })
        : null;
    if (row?.revokedAt !== null || row.connection.organization.deletedAt !== null)
      throw new UnauthorizedException({ code: 'invalid_token' });

    const key = `scim-token:${row.id}`;
    const count = await this.rateLimit.incr(key);
    if (count === 1) await this.rateLimit.expire(key, RATE.windowSec);
    if (count > RATE.limit) {
      throw new HttpException({ code: 'rate_limited' }, HttpStatus.TOO_MANY_REQUESTS);
    }

    const now = Date.now();
    if (row.lastUsedAt === null || now - row.lastUsedAt.getTime() >= LAST_USED_EVERY_MS) {
      void this.prisma.scimToken
        .update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } })
        .catch(() => undefined);
    }
    return {
      tokenId: row.id,
      connectionId: row.connection.id,
      organizationId: row.connection.organizationId,
    };
  }
}
