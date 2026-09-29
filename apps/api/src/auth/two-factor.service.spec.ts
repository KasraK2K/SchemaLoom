import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { encryptSecret, hashRecoveryCode, hotp, newTotpSecret, totpStep } from './totp';
import { TwoFactorService } from './two-factor.service';

const KEY = Buffer.alloc(32, 7).toString('base64');

function fakeRedis() {
  const store = new Map<string, number | string>();
  return {
    incr: (key: string) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, next);
      return Promise.resolve(next);
    },
    expire: () => Promise.resolve(1),
    set: (key: string, value: string) => {
      if (store.has(key)) return Promise.resolve(null);
      store.set(key, value);
      return Promise.resolve('OK');
    },
  } as unknown as Redis;
}

function setup() {
  const secret = newTotpSecret();
  const codes = [
    {
      id: 'r1',
      userId: 'u1',
      codeHash: hashRecoveryCode('abcde-fghij'),
      usedAt: null as Date | null,
    },
  ];
  const prisma = {
    user: {
      findUnique: () =>
        Promise.resolve({
          id: 'u1',
          email: 'a@example.com',
          passwordHash: null,
          totpSecret: encryptSecret(secret, KEY),
          totpConfirmedAt: new Date(),
        }),
    },
    recoveryCode: {
      findFirst: ({ where }: { where: { codeHash: string; usedAt: null } }) =>
        Promise.resolve(
          codes.find((c) => c.codeHash === where.codeHash && c.usedAt === null) ?? null,
        ),
      updateMany: ({ where }: { where: { id: string } }) => {
        const hit = codes.filter((c) => c.id === where.id && c.usedAt === null);
        for (const c of hit) c.usedAt = new Date();
        return Promise.resolve({ count: hit.length });
      },
    },
  } as unknown as PrismaService;
  const config = { get: () => KEY } as unknown as ConfigService<AppEnv, true>;
  return { service: new TwoFactorService(prisma, config, fakeRedis()), secret };
}

describe('TwoFactorService.verifySecondFactor', () => {
  it('accepts a current TOTP code once — A REPLAY IS REFUSED', async () => {
    const { service, secret } = setup();
    const code = hotp(secret, totpStep(Date.now()));
    expect(await service.verifySecondFactor('u1', code)).toBe(true);
    expect(await service.verifySecondFactor('u1', code)).toBe(false);
  });

  it('spends a recovery code exactly once, however it is typed', async () => {
    const { service } = setup();
    expect(await service.verifySecondFactor('u1', 'ABCDE FGHIJ')).toBe(true);
    expect(await service.verifySecondFactor('u1', 'abcde-fghij')).toBe(false);
  });

  it('bounds guesses per user', async () => {
    const { service } = setup();
    for (let i = 0; i < 10; i += 1) await service.verifySecondFactor('u1', '000000');
    await expect(service.verifySecondFactor('u1', '000000')).rejects.toMatchObject({ status: 429 });
  });
});
