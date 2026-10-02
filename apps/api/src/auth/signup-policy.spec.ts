import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../config/env';
import type { PrismaService } from '../prisma/prisma.service';
import { SignupPolicy, hashInviteToken } from './signup-policy';

const EMAIL = 'ana@example.com';
const TOKEN = 'invite-token';

/** One live invitation for EMAIL with TOKEN, unless `invited` is false. */
function policy(mode: 'invite' | 'open', opts: { users: number; invited: boolean }) {
  const tx = {
    $executeRaw: vi.fn(() => Promise.resolve(1)),
    user: { findFirst: vi.fn(() => Promise.resolve(opts.users > 0 ? { id: 'usr_1' } : null)) },
    invitation: {
      findFirst: vi.fn(({ where }: { where: { email: string; tokenHash?: string } }) =>
        Promise.resolve(
          opts.invited &&
            where.email === EMAIL &&
            (where.tokenHash === undefined || where.tokenHash === hashInviteToken(TOKEN))
            ? { id: 'inv_1' }
            : null,
        ),
      ),
    },
  };
  const prisma = {
    ...tx,
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  const config = { get: () => mode } as unknown as ConfigService<AppEnv, true>;
  return new SignupPolicy(prisma, config);
}

/** Resolves to `verified` when the policy lets the account be created. */
const attempt = (p: SignupPolicy, proof: { inviteToken?: string; emailProven: boolean }) =>
  p.createUser(EMAIL, proof, (_tx, verified) => Promise.resolve(verified));

describe('SignupPolicy (docs/phase16/DESIGN.md §1)', () => {
  it('open mode lets anyone in; a valid invite token still verifies the address', async () => {
    const open = policy('open', { users: 3, invited: true });
    expect(await open.isOpen()).toBe(true);
    expect(await attempt(open, { emailProven: false })).toBe(false);
    expect(await attempt(open, { inviteToken: TOKEN, emailProven: false })).toBe(true);
  });

  it('invite mode is open for the first account only', async () => {
    const empty = policy('invite', { users: 0, invited: false });
    expect(await empty.isOpen()).toBe(true);
    expect(await attempt(empty, { emailProven: false })).toBe(false);

    const used = policy('invite', { users: 1, invited: false });
    expect(await used.isOpen()).toBe(false);
    await expect(attempt(used, { emailProven: false })).rejects.toMatchObject({
      status: 403,
      response: { code: 'signup_closed' },
    });
  });

  it('invite mode admits a valid token, verified, but not a wrong or missing one', async () => {
    const p = policy('invite', { users: 1, invited: true });
    expect(await attempt(p, { inviteToken: TOKEN, emailProven: false })).toBe(true);
    await expect(attempt(p, { inviteToken: 'guessed', emailProven: false })).rejects.toMatchObject({
      status: 403,
    });
    // Knowing an invited address is not enough for a password sign-up.
    await expect(attempt(p, { emailProven: false })).rejects.toMatchObject({ status: 403 });
  });

  it('invite mode admits a proven address with a live invite (magic link, OAuth)', async () => {
    expect(await attempt(policy('invite', { users: 1, invited: true }), { emailProven: true })).toBe(
      false,
    );
    await expect(
      attempt(policy('invite', { users: 1, invited: false }), { emailProven: true }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
