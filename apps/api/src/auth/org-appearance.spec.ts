import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';
import { applyOrgAppearance } from './org-appearance';
import type { SignupPolicy } from './signup-policy';
import { hashInviteToken } from './signup-policy';

const ORG = 'org_acme';
const GRAPHITE = { theme: 'blueprint', variant: 'graphite', mode: 'dark' };

function fakeTx(settings: unknown) {
  return {
    organization: { findUnique: vi.fn(() => Promise.resolve({ settings })) },
    user: {
      create: vi.fn(() => Promise.resolve({ id: 'usr_new' })),
      update: vi.fn(() => Promise.resolve({})),
    },
    invitation: {
      findUnique: vi.fn(({ where }: { where: { tokenHash: string } }) =>
        Promise.resolve(
          where.tokenHash === hashInviteToken('tok') ? { organizationId: ORG } : null,
        ),
      ),
    },
  };
}

describe('applyOrgAppearance (docs/phase17/ORG-DEFAULT.md §2)', () => {
  it('copies the default onto the new account: theme, variant and mode', async () => {
    const tx = fakeTx({ defaultAppearance: GRAPHITE });
    await applyOrgAppearance(tx as unknown as Prisma.TransactionClient, 'usr_new', ORG);
    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'usr_new' },
      data: { uiTheme: 'blueprint', uiVariant: 'graphite', theme: 'dark' },
    });
  });

  it('writes nothing when the org has no default, or an unreadable one', async () => {
    for (const settings of [
      {},
      { defaultAppearance: null },
      { defaultAppearance: { theme: 'x' } },
    ]) {
      const tx = fakeTx(settings);
      await applyOrgAppearance(tx as unknown as Prisma.TransactionClient, 'usr_new', ORG);
      expect(tx.user.update).not.toHaveBeenCalled();
    }
  });
});

describe('invite sign-up starts on the org default', () => {
  function register(settings: unknown, inviteToken: string | undefined, verified: boolean) {
    const tx = fakeTx(settings);
    const signup = {
      createUser: vi.fn((_e: string, _p: unknown, create: (t: unknown, v: boolean) => unknown) =>
        create(tx, verified),
      ),
    };
    const auth = new AuthService(
      {} as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      signup as unknown as SignupPolicy,
    );
    // The verification mail is not what is under test.
    vi.spyOn(
      auth as unknown as { sendVerification: () => Promise<void> },
      'sendVerification',
    ).mockResolvedValue();
    return {
      tx,
      run: () =>
        auth.register({ email: 'a@x.io', password: 'SchemaLoom!demo1', name: 'A', inviteToken }),
    };
  }

  it('a valid invite token applies the inviting org’s default', async () => {
    const { tx, run } = register({ defaultAppearance: GRAPHITE }, 'tok', true);
    await run();
    expect(tx.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { uiTheme: 'blueprint', uiVariant: 'graphite', theme: 'dark' },
      }),
    );
  });

  it('a sign-up with no invite gets nothing', async () => {
    const { tx, run } = register({ defaultAppearance: GRAPHITE }, undefined, false);
    await run();
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(tx.invitation.findUnique).not.toHaveBeenCalled();
  });
});
