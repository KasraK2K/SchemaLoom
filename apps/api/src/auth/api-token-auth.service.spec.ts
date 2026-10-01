import { HttpException, UnauthorizedException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { ApiTokenAuthService, bearerToken, hashApiToken } from './api-token-auth.service';

const SECRET = 'slt_secret';
const HOUR = 3_600_000;

function rowWith(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    userId: 'u1',
    projectId: 'p1',
    tokenHash: hashApiToken(SECRET),
    scopes: ['read', 'drift'],
    expiresAt: new Date(Date.now() + HOUR),
    lastUsedAt: null,
    revokedAt: null,
    project: { organizationId: 'org1', deletedAt: null },
    ...over,
  };
}

function setup(row: ReturnType<typeof rowWith> | null) {
  const counts = new Map<string, number>();
  const prisma = {
    apiToken: {
      findUnique: vi.fn(({ where }: { where: { tokenHash: string } }) =>
        Promise.resolve(row !== null && where.tokenHash === row.tokenHash ? row : null),
      ),
      update: vi.fn(() => Promise.resolve({})),
    },
  };
  const redis = {
    incr: vi.fn((key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return Promise.resolve(next);
    }),
    expire: vi.fn(() => Promise.resolve(1)),
  };
  const service = new ApiTokenAuthService(
    prisma as unknown as PrismaService,
    redis as unknown as Redis,
  );
  return { service, prisma };
}

describe('bearerToken', () => {
  it('reads the secret out of a Bearer header and nothing else', () => {
    expect(bearerToken('Bearer slt_x')).toBe('slt_x');
    expect(bearerToken('bearer slt_x')).toBe('slt_x');
    expect(bearerToken('Basic abc')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});

describe('ApiTokenAuthService (Phase 11 §4)', () => {
  it("becomes the owner's principal in the project's org, carrying the token", async () => {
    const { service } = setup(rowWith());
    await expect(service.principalFor(SECRET)).resolves.toEqual({
      kind: 'user',
      userId: 'u1',
      orgId: 'org1',
      token: { tokenId: 't1', projectId: 'p1', scopes: ['read', 'drift'] },
    });
  });

  it.each([
    ['unknown', null],
    ['revoked', rowWith({ revokedAt: new Date() })],
    ['expired', rowWith({ expiresAt: new Date(Date.now() - 1) })],
    [
      'on a deleted project',
      rowWith({ project: { organizationId: 'org1', deletedAt: new Date() } }),
    ],
  ])('an %s token is the same 401 invalid_token', async (_label, row) => {
    const { service } = setup(row);
    const error = await service.principalFor(SECRET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as UnauthorizedException).getResponse()).toEqual({ code: 'invalid_token' });
  });

  it('never looks up a secret without the slt_ prefix', async () => {
    const { service, prisma } = setup(rowWith());
    await expect(service.principalFor('abc')).rejects.toThrow(UnauthorizedException);
    expect(prisma.apiToken.findUnique).not.toHaveBeenCalled();
  });

  it('allows 120 requests a minute, then 429 rate_limited', async () => {
    const { service } = setup(rowWith());
    for (let i = 0; i < 120; i++) await service.principalFor(SECRET);
    const error = await service.principalFor(SECRET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
  });

  it('writes lastUsedAt at most once a minute', async () => {
    const fresh = setup(rowWith());
    await fresh.service.principalFor(SECRET);
    expect(fresh.prisma.apiToken.update).toHaveBeenCalledTimes(1);

    const recent = setup(rowWith({ lastUsedAt: new Date(Date.now() - 1000) }));
    await recent.service.principalFor(SECRET);
    expect(recent.prisma.apiToken.update).not.toHaveBeenCalled();
  });
});
