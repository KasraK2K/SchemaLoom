import { createHash } from 'node:crypto';
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
import type { AuthPrincipal } from './subject';

export const API_TOKEN_PREFIX = 'slt_';

/** Phase 11 §4 step 2 — per token. */
const RATE = { limit: 120, windowSec: 60 };
const LAST_USED_EVERY_MS = 60_000;

/** sha256 hex, like `ShareLink.tokenHash`: the secret is never stored. */
export function hashApiToken(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** `Bearer slt_…` → the secret, or `undefined` when the header isn't a token. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match?.[1];
}

/**
 * Phase 11 §4 steps 1–2: a bearer token becomes its owner's user principal, in the
 * project's organisation, carrying `token`. Missing, revoked and expired are the same 401
 * with no hint which. What the owner may do is the resolver's answer, every request.
 */
@Injectable()
export class ApiTokenAuthService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_RATELIMIT) private readonly rateLimit: Redis,
  ) {}

  async principalFor(secret: string): Promise<Extract<AuthPrincipal, { kind: 'user' }>> {
    const row = secret.startsWith(API_TOKEN_PREFIX)
      ? await this.prisma.apiToken.findUnique({
          where: { tokenHash: hashApiToken(secret) },
          include: { project: { select: { organizationId: true, deletedAt: true } } },
        })
      : null;
    const now = Date.now();
    if (
      row?.revokedAt !== null ||
      row.expiresAt.getTime() <= now ||
      row.project.deletedAt !== null
    ) {
      throw new UnauthorizedException({ code: 'invalid_token' });
    }

    // Fails closed (redis.tokens.ts): a Redis error propagates, it never admits.
    const key = `api-token:${row.id}`;
    const count = await this.rateLimit.incr(key);
    if (count === 1) await this.rateLimit.expire(key, RATE.windowSec);
    if (count > RATE.limit) {
      throw new HttpException({ code: 'rate_limited' }, HttpStatus.TOO_MANY_REQUESTS);
    }

    if (row.lastUsedAt === null || now - row.lastUsedAt.getTime() >= LAST_USED_EVERY_MS) {
      void this.prisma.apiToken
        .update({ where: { id: row.id }, data: { lastUsedAt: new Date(now) } })
        .catch(() => undefined);
    }

    return {
      kind: 'user',
      userId: row.userId,
      orgId: row.project.organizationId,
      token: { tokenId: row.id, projectId: row.projectId, scopes: row.scopes },
    };
  }
}
