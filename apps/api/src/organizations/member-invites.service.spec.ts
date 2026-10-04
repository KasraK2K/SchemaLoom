import type { OrgRole } from '@schemaloom/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import { MemberInvitesService } from './member-invites.service';

const ORG = 'org_acme';
const ROW = {
  id: 'inv_1',
  email: 'new@example.com',
  orgRole: 'member' as OrgRole,
  expiresAt: new Date('2026-10-09T00:00:00Z'),
  invitedBy: { name: 'Ana', email: 'ana@example.com' },
};

function harness(opts: { actor?: OrgRole | null; member?: boolean; pending?: OrgRole | null }) {
  const actor = opts.actor === undefined ? 'owner' : opts.actor;
  const pending = opts.pending === undefined ? 'member' : opts.pending;
  const invitation = {
    findFirst: vi.fn(() => Promise.resolve(pending === null ? null : { ...ROW, orgRole: pending })),
    findMany: vi.fn(() => Promise.resolve([ROW])),
    create: vi.fn(({ data }: { data: object }) => Promise.resolve({ ...ROW, ...data })),
    update: vi.fn(({ data }: { data: object }) => Promise.resolve({ ...ROW, ...data })),
  };
  const tx = { invitation, auditLog: { create: vi.fn(() => Promise.resolve({})) } };
  const prisma = {
    ...tx,
    orgMember: {
      findFirst: vi.fn(({ where }: { where: { userId?: string } }) =>
        Promise.resolve(
          where.userId !== undefined
            ? actor === null
              ? null
              : { organizationId: ORG, role: actor }
            : opts.member
              ? { userId: 'usr_existing' }
              : null,
        ),
      ),
    },
    user: { findUniqueOrThrow: vi.fn(() => Promise.resolve({ name: 'Ana', email: 'a@x.io' })) },
    organization: { findUniqueOrThrow: vi.fn(() => Promise.resolve({ name: 'Acme' })) },
    $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  const mail = { sendMemberInvitationEmail: vi.fn(() => Promise.resolve()) };
  return {
    invites: new MemberInvitesService(prisma, mail as unknown as MailService),
    invitation,
    mail,
  };
}

describe('MemberInvitesService (docs/phase16/DESIGN.md §2)', () => {
  it('an owner invites; a repeat invite to the same address updates the pending one', async () => {
    const fresh = harness({ pending: null });
    await fresh.invites.create('usr_actor', 'acme', ' New@Example.com ', 'admin');
    expect(fresh.invitation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ email: 'new@example.com', orgRole: 'admin' }),
      }),
    );
    expect(fresh.mail.sendMemberInvitationEmail).toHaveBeenCalledWith(
      'new@example.com',
      'Ana',
      'Acme',
      expect.any(String),
    );

    const again = harness({});
    await again.invites.create('usr_actor', 'acme', 'new@example.com', 'member');
    expect(again.invitation.update).toHaveBeenCalled();
    expect(again.invitation.create).not.toHaveBeenCalled();
  });

  it('only owners invite owners; members, guests and outsiders never invite', async () => {
    await expect(
      harness({ actor: 'admin' }).invites.create('usr_actor', 'acme', 'x@y.io', 'owner'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      harness({ actor: 'member' }).invites.create('usr_actor', 'acme', 'x@y.io', 'member'),
    ).rejects.toMatchObject({ status: 403 });
    await expect(harness({ actor: null }).invites.list('usr_actor', 'acme')).rejects.toMatchObject({
      status: 404,
    });
    // An admin cannot resend or revoke an owner invite an owner made either.
    await expect(
      harness({ actor: 'admin', pending: 'owner' }).invites.revoke('usr_actor', 'acme', 'inv_1'),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('an existing member is 409, not a second invite', async () => {
    const h = harness({ member: true });
    await expect(
      h.invites.create('usr_actor', 'acme', 'new@example.com', 'member'),
    ).rejects.toMatchObject({ status: 409, response: { code: 'already_member' } });
    expect(h.mail.sendMemberInvitationEmail).not.toHaveBeenCalled();
  });

  it('resend rotates the token and expiry; revoke marks it revoked; unknown ids 404', async () => {
    const h = harness({});
    await h.invites.resend('usr_actor', 'acme', 'inv_1');
    expect(h.invitation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { tokenHash: expect.any(String), expiresAt: expect.any(Date) },
      }),
    );
    expect(h.mail.sendMemberInvitationEmail).toHaveBeenCalledTimes(1);

    await h.invites.revoke('usr_actor', 'acme', 'inv_1');
    expect(h.invitation.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { revokedAt: expect.any(Date) } }),
    );

    await expect(
      harness({ pending: null }).invites.revoke('usr_actor', 'acme', 'inv_x'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
