import { beforeEach, describe, expect, it } from 'vitest';
import { VerificationPurpose } from '../generated/prisma/enums';
import type { PrismaService } from '../prisma/prisma.service';
import { VerificationService, hashVerificationToken } from './verification.service';

interface TokenRow {
  id: string;
  userId: string | null;
  email: string;
  purpose: VerificationPurpose;
  tokenHash: string;
  consumedAt: Date | null;
  expiresAt: Date;
}

function fakePrisma() {
  const rows: TokenRow[] = [];
  let seq = 0;
  const matches = (row: TokenRow, where: Partial<TokenRow>): boolean =>
    Object.entries(where).every(([key, value]) => row[key as keyof TokenRow] === value);

  const verificationToken = {
    create({ data }: { data: Omit<TokenRow, 'id' | 'consumedAt'> }) {
      seq += 1;
      const row: TokenRow = { id: `v${String(seq)}`, consumedAt: null, ...data };
      rows.push(row);
      return Promise.resolve(row);
    },
    findUnique({ where }: { where: Partial<TokenRow> }) {
      return Promise.resolve(rows.find((r) => matches(r, where)) ?? null);
    },
    updateMany({ where, data }: { where: Partial<TokenRow>; data: Partial<TokenRow> }) {
      const hit = rows.filter((r) => matches(r, where));
      for (const row of hit) Object.assign(row, data);
      return Promise.resolve({ count: hit.length });
    },
  };
  return { rows, service: { verificationToken } as unknown as PrismaService };
}

let prisma: ReturnType<typeof fakePrisma>;
let verification: VerificationService;
const EMAIL_VERIFY = VerificationPurpose.email_verification;
const RESET = VerificationPurpose.password_reset;

beforeEach(() => {
  prisma = fakePrisma();
  verification = new VerificationService(prisma.service);
});

describe('VerificationService', () => {
  it('stores only the digest and returns the raw token once', async () => {
    const raw = await verification.issue(EMAIL_VERIFY, 'a@example.com', 'u1');
    expect(prisma.rows[0]!.tokenHash).toBe(hashVerificationToken(raw));
    expect(JSON.stringify(prisma.rows)).not.toContain(raw);
  });

  it('consumes a token exactly once — A REPLAY IS REFUSED', async () => {
    const raw = await verification.issue(EMAIL_VERIFY, 'a@example.com', 'u1');
    await expect(verification.consume(raw, EMAIL_VERIFY)).resolves.toEqual({
      userId: 'u1',
      email: 'a@example.com',
    });
    await expect(verification.consume(raw, EMAIL_VERIFY)).rejects.toMatchObject({
      response: { code: 'TOKEN_INVALID' },
    });
  });

  it('refuses a token presented for the wrong purpose', async () => {
    const raw = await verification.issue(EMAIL_VERIFY, 'a@example.com', 'u1');
    await expect(verification.consume(raw, RESET)).rejects.toThrow();
    // ...and refusing it did not burn it.
    expect(prisma.rows[0]!.consumedAt).toBeNull();
  });

  it('refuses an expired token and an unknown one', async () => {
    const raw = await verification.issue(RESET, 'a@example.com', 'u1');
    const later = new Date(Date.now() + 2 * 3600 * 1000);
    await expect(verification.consume(raw, RESET, later)).rejects.toThrow();
    await expect(verification.consume('never-issued', RESET)).rejects.toThrow();
  });

  it('issuing a second token of the same purpose kills the first', async () => {
    const first = await verification.issue(RESET, 'a@example.com', 'u1');
    const second = await verification.issue(RESET, 'a@example.com', 'u1');
    await expect(verification.consume(first, RESET)).rejects.toThrow();
    await expect(verification.consume(second, RESET)).resolves.toBeDefined();
  });

  it('does not disturb a different purpose for the same address', async () => {
    const verify = await verification.issue(EMAIL_VERIFY, 'a@example.com', 'u1');
    await verification.issue(RESET, 'a@example.com', 'u1');
    await expect(verification.consume(verify, EMAIL_VERIFY)).resolves.toBeDefined();
  });
});
