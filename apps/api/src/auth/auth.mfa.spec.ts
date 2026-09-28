import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../config/env';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService, isMfaChallenge } from './auth.service';
import type { TokensService } from './tokens.service';
import type { TwoFactorService } from './two-factor.service';
import type { VerificationService } from './verification.service';

interface UserRow {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
  totpConfirmedAt: Date | null;
}

function setup(users: UserRow[], consumed: { userId: string | null; email: string } = { userId: null, email: '' }) {
  const prisma = {
    user: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(users.find((u) => u.id === where.id) ?? null),
      findFirst: ({ where }: { where: { email: string } }) =>
        Promise.resolve(users.find((u) => u.email === where.email) ?? null),
      update: ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        Object.assign(users.find((u) => u.id === where.id)!, data);
        return Promise.resolve({});
      },
      updateMany: ({ where, data }: { where: { id: string }; data: Partial<UserRow> }) => {
        const hit = users.filter((u) => u.id === where.id && u.emailVerifiedAt === null);
        for (const u of hit) Object.assign(u, data);
        return Promise.resolve({ count: hit.length });
      },
      create: ({ data }: { data: Omit<UserRow, 'id' | 'totpConfirmedAt'> }) => {
        const row = { id: `u${String(users.length + 1)}`, totpConfirmedAt: null, ...data };
        users.push(row);
        return Promise.resolve({ id: row.id });
      },
    },
    orgMember: { findFirst: () => Promise.resolve(null) },
  } as unknown as PrismaService;
  const tokens = {
    accessTtlSec: 900,
    startSession: vi.fn((userId: string) =>
      Promise.resolve({ refreshToken: 'rt', familyId: 'f', userId, expiresAt: new Date(Date.now() + 60_000) }),
    ),
    issueAccessToken: vi.fn(() => Promise.resolve('at')),
    issueMfaChallenge: vi.fn((userId: string) => Promise.resolve(`challenge:${userId}`)),
    verifyMfaChallenge: vi.fn((token: string) =>
      Promise.resolve(
        token.startsWith('challenge:')
          ? { userId: token.slice('challenge:'.length), challengeId: 'c1' }
          : null,
      ),
    ),
  };
  const twoFactor = {
    throttle: vi.fn(() => Promise.resolve()),
    verifySecondFactor: vi.fn((_userId: string, code: string) => Promise.resolve(code === '123456')),
  };
  const verification = { consume: vi.fn(() => Promise.resolve(consumed)) };
  const config = { get: () => 'csrf-secret' } as unknown as ConfigService<AppEnv, true>;
  const auth = new AuthService(
    prisma,
    tokens as unknown as TokensService,
    verification as unknown as VerificationService,
    {} as MailService,
    config,
    twoFactor as unknown as TwoFactorService,
  );
  return { auth, tokens, twoFactor, users };
}

const plain: UserRow = { id: 'u1', email: 'a@example.com', emailVerifiedAt: new Date(), totpConfirmedAt: null };
const guarded: UserRow = { id: 'u2', email: 'b@example.com', emailVerifiedAt: new Date(), totpConfirmedAt: new Date() };

describe('the 2FA login gate', () => {
  it('opens a session for a user without 2FA', async () => {
    const { auth, tokens } = setup([{ ...plain }]);
    const outcome = await auth.issueSession('u1', {});
    expect(isMfaChallenge(outcome)).toBe(false);
    expect(tokens.startSession).toHaveBeenCalledOnce();
  });

  it('gives a 2FA user a challenge and NO refresh family', async () => {
    const { auth, tokens } = setup([{ ...guarded }]);
    expect(await auth.issueSession('u2', {})).toEqual({ mfaChallenge: 'challenge:u2' });
    expect(tokens.startSession).not.toHaveBeenCalled();
    expect(tokens.issueAccessToken).not.toHaveBeenCalled();
  });

  it('trades challenge + correct code for a session, and nothing else does', async () => {
    const { auth, tokens, twoFactor } = setup([{ ...guarded }]);
    await expect(auth.completeMfa('forged', '123456', {})).rejects.toThrow();
    await expect(auth.completeMfa('challenge:u2', '000000', {})).rejects.toThrow();
    expect(tokens.startSession).not.toHaveBeenCalled();

    const bundle = await auth.completeMfa('challenge:u2', '123456', {});
    expect(bundle.userId).toBe('u2');
    expect(twoFactor.throttle).toHaveBeenCalledWith('mfa:challenge:c1', expect.anything());
  });
});

describe('magic link consume', () => {
  it('verifies the address of the user the link was issued to', async () => {
    const { auth, users } = setup([{ ...plain, emailVerifiedAt: null }], { userId: 'u1', email: plain.email });
    expect(await auth.consumeMagicLink('t')).toBe('u1');
    expect(users[0]!.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('creates a verified user for an address with no account', async () => {
    const { auth, users } = setup([], { userId: null, email: 'new@example.com' });
    const userId = await auth.consumeMagicLink('t');
    expect(users).toEqual([
      expect.objectContaining({ id: userId, email: 'new@example.com', name: 'new', emailVerifiedAt: expect.any(Date) }),
    ]);
  });

  it('uses an account registered after the link was sent instead of creating a second', async () => {
    const { auth, users } = setup([{ ...plain }], { userId: null, email: plain.email });
    expect(await auth.consumeMagicLink('t')).toBe('u1');
    expect(users).toHaveLength(1);
  });

  it('still goes through the gate: a 2FA user gets a challenge, not a session', async () => {
    const { auth } = setup([{ ...guarded }], { userId: 'u2', email: guarded.email });
    const userId = await auth.consumeMagicLink('t');
    expect(isMfaChallenge(await auth.issueSession(userId, {}))).toBe(true);
  });
});
