import type { OrgRole } from '@schemaloom/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { PermissionResolver } from '../access';
import type { PrismaService } from '../prisma/prisma.service';
import { GroupsService } from './groups.service';
import { MembersService, assertMayList, assertMemberChange } from './members.service';

const ORG = 'org_acme';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('assertMayList (doc 05 §3.2)', () => {
  it('owner, admin and member list; a guest is 403 and a non-member 404', () => {
    for (const role of ['owner', 'admin', 'member'] as const)
      expect(() => {
        assertMayList(role);
      }).not.toThrow();
    expect(
      thrown(() => {
        assertMayList('guest');
      }),
    ).toMatchObject({ status: 403 });
    expect(
      thrown(() => {
        assertMayList(null);
      }),
    ).toMatchObject({ status: 404 });
  });
});

describe('assertMemberChange (doc 05 §3.2)', () => {
  it('members and guests may not manage members', () => {
    expect(
      thrown(() => {
        assertMemberChange('member', 'guest', 'member', 1);
      }),
    ).toMatchObject({ status: 403 });
    expect(
      thrown(() => {
        assertMemberChange('guest', 'member', null, 1);
      }),
    ).toMatchObject({ status: 403 });
    expect(
      thrown(() => {
        assertMemberChange(null, 'member', null, 1);
      }),
    ).toMatchObject({ status: 404 });
  });

  it('an admin manages admins, members and guests, but never an owner and never mints one', () => {
    expect(() => {
      assertMemberChange('admin', 'member', 'admin', 1);
    }).not.toThrow();
    expect(() => {
      assertMemberChange('admin', 'admin', null, 1);
    }).not.toThrow();
    expect(
      thrown(() => {
        assertMemberChange('admin', 'owner', 'member', 2);
      }),
    ).toMatchObject({ status: 403 });
    expect(
      thrown(() => {
        assertMemberChange('admin', 'owner', null, 2);
      }),
    ).toMatchObject({ status: 403 });
    expect(
      thrown(() => {
        assertMemberChange('admin', 'member', 'owner', 1);
      }),
    ).toMatchObject({ status: 403 });
  });

  it('the last owner is never demoted or removed, even by themselves', () => {
    expect(
      thrown(() => {
        assertMemberChange('owner', 'owner', 'admin', 1);
      }),
    ).toMatchObject({
      response: { code: 'last_owner' },
    });
    expect(
      thrown(() => {
        assertMemberChange('owner', 'owner', null, 1);
      }),
    ).toMatchObject({
      response: { code: 'last_owner' },
    });
    expect(() => {
      assertMemberChange('owner', 'owner', 'admin', 2);
    }).not.toThrow();
    expect(() => {
      assertMemberChange('owner', 'member', 'owner', 1);
    }).not.toThrow();
  });
});

function harness(over: { actor?: OrgRole; target?: OrgRole | null; owners?: number } = {}) {
  const actor = over.actor ?? 'owner';
  const target = over.target === undefined ? 'member' : over.target;
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    orgMember: {
      findUnique: vi.fn(({ where }: { where: { organizationId_userId: { userId: string } } }) =>
        Promise.resolve(
          where.organizationId_userId.userId === 'usr_actor'
            ? { role: actor }
            : target === null
              ? null
              : { role: target, userId: 'usr_target' },
        ),
      ),
      count: vi.fn().mockResolvedValue(over.owners ?? 1),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    groupMember: {
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
      create: vi.fn().mockResolvedValue({}),
    },
    user: { update: vi.fn().mockResolvedValue({}) },
    organization: { update: vi.fn().mockResolvedValue({}) },
    userGroup: {
      create: vi
        .fn()
        .mockResolvedValue({ id: 'grp_1', name: 'Analysts', description: null, members: [] }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    ...tx,
    orgMember: {
      ...tx.orgMember,
      findFirst: vi.fn().mockResolvedValue({ organizationId: ORG, role: actor }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        role: 'admin',
        joinedAt: new Date(0),
        user: { id: 'usr_target', name: 'T', email: 't@x' },
      }),
    },
    userGroup: {
      ...tx.userGroup,
      findFirst: vi
        .fn()
        .mockResolvedValue({ id: 'grp_1', name: 'Analysts', description: null, members: [] }),
    },
    $transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as PrismaService;
  const invalidate = vi.fn().mockResolvedValue(undefined);
  const resolver = { invalidate } as unknown as PermissionResolver;
  return {
    members: new MembersService(prisma, resolver),
    groups: new GroupsService(prisma, resolver),
    prisma,
    tx,
    invalidate,
  };
}

describe('MembersService', () => {
  it('a role change is locked, audited, bumps the target user and invalidates them (§9.3)', async () => {
    const h = harness();
    await h.members.setRole('usr_actor', 'acme', 'usr_target', 'admin');
    expect(h.tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(h.tx.orgMember.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { role: 'admin' } }),
    );
    expect(h.tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'org_member.role_changed',
        metadata: { before: 'member', after: 'admin' },
      }),
    });
    expect(h.tx.user.update).toHaveBeenCalledWith({
      where: { id: 'usr_target' },
      data: { permGeneration: { increment: 1 } },
    });
    expect(h.invalidate).toHaveBeenCalledWith({ user: 'usr_target' });
  });

  it('removal drops the membership and the org group memberships, leaving grants in place (R12.2)', async () => {
    const h = harness();
    await h.members.remove('usr_actor', 'acme', 'usr_target');
    expect(h.tx.groupMember.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'usr_target', group: { organizationId: ORG } },
    });
    expect(h.tx.orgMember.delete).toHaveBeenCalled();
    expect(h.invalidate).toHaveBeenCalledWith({ user: 'usr_target' });
  });

  it('re-checks the actor under the lock and 404s an unknown target', async () => {
    await expect(
      harness({ target: null }).members.remove('usr_actor', 'acme', 'usr_x'),
    ).rejects.toMatchObject({
      status: 404,
    });
    const demoted = harness({ actor: 'admin', target: 'owner', owners: 2 });
    await expect(demoted.members.remove('usr_actor', 'acme', 'usr_target')).rejects.toMatchObject({
      status: 403,
    });
    expect(demoted.tx.orgMember.delete).not.toHaveBeenCalled();
    expect(demoted.invalidate).not.toHaveBeenCalled();
  });
});

describe('GroupsService', () => {
  it('create bumps the org counter and invalidates the org (§9.3)', async () => {
    const h = harness();
    (h.prisma.userGroup.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null); // name free
    await h.groups.create('usr_actor', 'acme', { name: 'Analysts' });
    expect(h.tx.organization.update).toHaveBeenCalledWith({
      where: { id: ORG },
      data: { permGeneration: { increment: 1 } },
    });
    expect(h.invalidate).toHaveBeenCalledWith({ org: ORG });
  });

  it('a duplicate name is 409', async () => {
    const h = harness();
    await expect(h.groups.create('usr_actor', 'acme', { name: 'analysts' })).rejects.toMatchObject({
      status: 409,
    });
  });

  it('adding a member bumps that user only; a non-org user is 404', async () => {
    const h = harness();
    await h.groups.addMember('usr_actor', 'acme', 'grp_1', 'usr_target');
    expect(h.tx.user.update).toHaveBeenCalledWith({
      where: { id: 'usr_target' },
      data: { permGeneration: { increment: 1 } },
    });
    expect(h.tx.organization.update).not.toHaveBeenCalled();
    expect(h.invalidate).toHaveBeenCalledWith({ user: 'usr_target' });

    const outsider = harness({ target: null });
    await expect(
      outsider.groups.addMember('usr_actor', 'acme', 'grp_1', 'usr_x'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('a member may list but not write', async () => {
    const h = harness({ actor: 'member' });
    (h.prisma.userGroup as unknown as { findMany: unknown }).findMany = vi
      .fn()
      .mockResolvedValue([]);
    await expect(h.groups.list('usr_actor', 'acme')).resolves.toEqual([]);
    await expect(h.groups.create('usr_actor', 'acme', { name: 'X' })).rejects.toMatchObject({
      status: 403,
    });
  });
});
