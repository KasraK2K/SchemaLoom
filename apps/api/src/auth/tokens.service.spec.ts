import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppEnv } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { TokensService, hashRefreshToken } from './tokens.service';

interface SessionRow {
  id: string;
  userId: string;
  familyId: string;
  refreshTokenHash: string;
  rotatedAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  expiresAt: Date;
  userAgent: string | null;
  ip: string | null;
}

/** An in-memory `sessions` table. No Postgres, no container, same semantics. */
function fakePrisma() {
  const rows: SessionRow[] = [];
  let seq = 0;

  const matches = (row: SessionRow, where: Partial<SessionRow>): boolean =>
    Object.entries(where).every(([key, value]) => {
      const actual = row[key as keyof SessionRow];
      if (typeof value === 'object' && value !== null && 'not' in value) {
        return actual !== (value as { not: unknown }).not;
      }
      return actual instanceof Date && value instanceof Date
        ? actual.getTime() === value.getTime()
        : actual === value;
    });

  const session = {
    create({ data }: { data: Omit<SessionRow, 'id' | 'rotatedAt' | 'revokedAt' | 'lastUsedAt'> }) {
      seq += 1;
      const row: SessionRow = {
        id: `s${String(seq)}`,
        rotatedAt: null,
        revokedAt: null,
        lastUsedAt: null,
        ...data,
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    findUnique({ where }: { where: Partial<SessionRow> }) {
      return Promise.resolve(rows.find((r) => matches(r, where)) ?? null);
    },
    updateMany({ where, data }: { where: Partial<SessionRow>; data: Partial<SessionRow> }) {
      const hit = rows.filter((r) => matches(r, where));
      for (const row of hit) Object.assign(row, data);
      return Promise.resolve({ count: hit.length });
    },
  };

  const client = {
    session,
    $transaction: (fn: (tx: { session: typeof session }) => Promise<unknown>) => fn({ session }),
  };
  return { rows, service: client as unknown as PrismaService };
}

const ENV: Partial<Record<keyof AppEnv, string>> = {
  ACCESS_TOKEN_TTL: '15m',
  REFRESH_TOKEN_TTL: '30d',
  JWT_ACCESS_SECRET: 'access-secret-that-is-at-least-32-chars-long',
};

const config = {
  get: (key: keyof AppEnv) => ENV[key],
} as unknown as ConfigService<AppEnv, true>;

let prisma: ReturnType<typeof fakePrisma>;
let tokens: TokensService;

beforeEach(() => {
  prisma = fakePrisma();
  tokens = new TokensService(prisma.service, new JwtService({}), config);
});

describe('refresh families', () => {
  it('stores only the digest — the raw token never reaches the database', async () => {
    const issued = await tokens.startSession('u1', { ip: '127.0.0.1' });
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]!.refreshTokenHash).toBe(hashRefreshToken(issued.refreshToken));
    expect(JSON.stringify(prisma.rows)).not.toContain(issued.refreshToken);
  });

  it('rotation issues a new token in the same family and spends the old row', async () => {
    const first = await tokens.startSession('u1');
    const second = await tokens.rotate(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.familyId).toBe(first.familyId);
    expect(prisma.rows).toHaveLength(2);
    expect(prisma.rows[0]!.rotatedAt).toBeInstanceOf(Date);
    expect(prisma.rows[1]!.rotatedAt).toBeNull();
    // Absolute family lifetime: rotating does not extend it.
    expect(second.expiresAt.getTime()).toBe(first.expiresAt.getTime());
  });

  it('a replay takes the legitimate successor down with it', async () => {
    const first = await tokens.startSession('u1');
    const second = await tokens.rotate(first.refreshToken);
    await expect(tokens.rotate(first.refreshToken)).rejects.toThrow();
    // There is no way to tell the victim from the thief, so both are logged out.
    await expect(tokens.rotate(second.refreshToken)).rejects.toThrow();
  });

  it('REUSE OF A CONSUMED REFRESH TOKEN KILLS THE WHOLE FAMILY', async () => {
    const first = await tokens.startSession('u1');
    const second = await tokens.rotate(first.refreshToken);
    const third = await tokens.rotate(second.refreshToken);
    expect(prisma.rows.every((r) => r.revokedAt === null)).toBe(true);

    // The thief replays a token the victim already spent.
    await expect(tokens.rotate(first.refreshToken)).rejects.toMatchObject({
      response: { code: 'REFRESH_TOKEN_REUSED' },
    });

    expect(prisma.rows.every((r) => r.revokedAt instanceof Date)).toBe(true);
    // Including the live one the victim's browser still holds.
    await expect(tokens.rotate(third.refreshToken)).rejects.toThrow();
  });

  it('leaves other families alone when one dies', async () => {
    const laptop = await tokens.startSession('u1');
    const phone = await tokens.startSession('u1');
    await tokens.rotate(laptop.refreshToken);
    await expect(tokens.rotate(laptop.refreshToken)).rejects.toThrow();

    const phoneRows = prisma.rows.filter((r) => r.familyId === phone.familyId);
    expect(phoneRows.every((r) => r.revokedAt === null)).toBe(true);
    await expect(tokens.rotate(phone.refreshToken)).resolves.toBeDefined();
  });

  it('rejects an unknown, a revoked and an expired token', async () => {
    await expect(tokens.rotate('never-issued')).rejects.toThrow();

    const revoked = await tokens.startSession('u1');
    await tokens.revokeByRefreshToken(revoked.refreshToken);
    await expect(tokens.rotate(revoked.refreshToken)).rejects.toThrow();

    const expired = await tokens.startSession('u2');
    prisma.rows.at(-1)!.expiresAt = new Date(Date.now() - 1000);
    await expect(tokens.rotate(expired.refreshToken)).rejects.toThrow();
  });

  it('revokeAllForUser ends every family for one user only', async () => {
    const mine = await tokens.startSession('u1');
    const theirs = await tokens.startSession('u2');
    await tokens.revokeAllForUser('u1');
    await expect(tokens.rotate(mine.refreshToken)).rejects.toThrow();
    await expect(tokens.rotate(theirs.refreshToken)).resolves.toBeDefined();
  });
});

describe('access and share-link tokens', () => {
  it('round-trips an access token with its org claim', async () => {
    const token = await tokens.issueAccessToken({ userId: 'u1', orgId: 'org1' });
    expect(await tokens.verifyAccessToken(token)).toEqual({ userId: 'u1', orgId: 'org1' });
  });

  it('carries a null org for a user with no organisation yet', async () => {
    const token = await tokens.issueAccessToken({ userId: 'u1', orgId: null });
    expect(await tokens.verifyAccessToken(token)).toEqual({ userId: 'u1', orgId: null });
  });

  it('rejects a tampered or foreign access token instead of throwing', async () => {
    const token = await tokens.issueAccessToken({ userId: 'u1', orgId: null });
    expect(await tokens.verifyAccessToken(`${token}x`)).toBeNull();
    expect(await tokens.verifyAccessToken('garbage')).toBeNull();
  });

  it('will not let sl_session stand in for sl_access, or the reverse', async () => {
    const { token: share } = await tokens.issueShareSession(
      { shareLinkId: 'l1', projectId: 'p1', resourceId: 'p1' },
      null,
    );
    const access = await tokens.issueAccessToken({ userId: 'u1', orgId: 'o1' });

    expect(await tokens.verifyAccessToken(share)).toBeNull();
    expect(await tokens.verifyShareSession(access)).toBeNull();
    expect(await tokens.verifyShareSession(share)).toEqual({
      shareLinkId: 'l1',
      projectId: 'p1',
      resourceId: 'p1',
    });
  });

  it('caps the share session at 12 hours and at the link expiry, whichever is sooner', async () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const claims = { shareLinkId: 'l1', projectId: 'p1', resourceId: 'p1' };
    expect((await tokens.issueShareSession(claims, null, now)).ttlSec).toBe(12 * 3600);
    expect(
      (await tokens.issueShareSession(claims, new Date('2026-01-02T00:00:00Z'), now)).ttlSec,
    ).toBe(12 * 3600);
    expect(
      (await tokens.issueShareSession(claims, new Date('2026-01-01T00:30:00Z'), now)).ttlSec,
    ).toBe(1800);
  });
});

describe('2FA challenge', () => {
  it('is its own audience: neither an access token nor a challenge stands in for the other', async () => {
    const challenge = await tokens.issueMfaChallenge('u1');
    const access = await tokens.issueAccessToken({ userId: 'u1', orgId: null });
    expect(await tokens.verifyAccessToken(challenge)).toBeNull();
    expect(await tokens.verifyMfaChallenge(access)).toBeNull();
    expect(await tokens.verifyMfaChallenge(challenge)).toMatchObject({ userId: 'u1' });
  });
});

describe('device sessions', () => {
  it('revoking a family makes its refresh fail, and only the owner can revoke it', async () => {
    const laptop = await tokens.startSession('u1');
    expect(await tokens.revokeFamilyForUser('intruder', laptop.familyId)).toBe(false);
    await expect(tokens.rotate(laptop.refreshToken)).resolves.toMatchObject({ userId: 'u1' });

    const phone = await tokens.startSession('u1');
    expect(await tokens.revokeFamilyForUser('u1', phone.familyId)).toBe(true);
    await expect(tokens.rotate(phone.refreshToken)).rejects.toThrow();
    expect(await tokens.familyOf(phone.refreshToken)).toBeNull();
  });

  it('"log out other devices" keeps the current family alive', async () => {
    const here = await tokens.startSession('u1');
    const there = await tokens.startSession('u1');
    await tokens.revokeOtherFamilies('u1', here.familyId);
    await expect(tokens.rotate(there.refreshToken)).rejects.toThrow();
    await expect(tokens.rotate(here.refreshToken)).resolves.toMatchObject({ userId: 'u1' });
  });
});
