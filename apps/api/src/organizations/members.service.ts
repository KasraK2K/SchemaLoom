import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { OrgRole } from '@schemaloom/contracts';
import { PermissionResolver } from '../access';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertRoleAdmin } from './roles.service';

export interface MemberView {
  userId: string;
  name: string;
  email: string;
  role: OrgRole;
  joinedAt: string;
}

/** The caller's membership in the org the slug names, or `null` (a non-member and a
 *  missing org look the same). */
export function orgMembership(
  prisma: PrismaService,
  userId: string,
  orgSlug: string,
): Promise<{ organizationId: string; role: OrgRole } | null> {
  return prisma.orgMember.findFirst({
    where: { userId, organization: { slug: orgSlug, deletedAt: null } },
    select: { organizationId: true, role: true },
  });
}

/**
 * Doc 05 §3.2 — "List org members, groups, workspaces": owner, admin, member. A guest
 * gets 403 (the §12.1 worked example), a non-member the 404 of a missing org.
 */
export function assertMayList(orgRole: OrgRole | null): void {
  if (orgRole === null) throw new NotFoundException({ code: 'not_found' });
  if (orgRole === 'guest') {
    throw new ForbiddenException({
      code: 'forbidden_org_role',
      required: ['owner', 'admin', 'member'],
    });
  }
}

/**
 * Doc 05 §3.2 for a role change (`next`) or a removal (`next = null`), checked in order:
 * the actor is owner or admin; only an owner may touch an owner or make one (an admin who
 * could mint owners could take the org); and the last owner is never demoted or removed
 * (doc 02 §8.5 — an org with no owner cannot be administered by anyone).
 */
export function assertMemberChange(
  actor: OrgRole | null,
  target: OrgRole,
  next: OrgRole | null,
  ownerCount: number,
): void {
  assertRoleAdmin(actor);
  if ((target === 'owner' || next === 'owner') && actor !== 'owner') {
    throw new ForbiddenException({ code: 'forbidden_org_role', required: ['owner'] });
  }
  if (target === 'owner' && next !== 'owner' && ownerCount <= 1) {
    throw new BadRequestException({ code: 'last_owner' });
  }
}

/**
 * Doc 05 §3.2 org members. Every write follows §9.3: mutate + audit + the target's
 * `User.permGeneration++` in one transaction, then invalidate. The org row is locked
 * `FOR UPDATE` first, so two owners demoting each other at once cannot both pass the
 * last-owner count.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
  ) {}

  async list(userId: string, orgSlug: string): Promise<MemberView[]> {
    const member = await orgMembership(this.prisma, userId, orgSlug);
    assertMayList(member?.role ?? null);
    if (member === null) return []; // unreachable: assertMayList 404s it
    const rows = await this.prisma.orgMember.findMany({
      where: { organizationId: member.organizationId },
      select: MEMBER,
      orderBy: { user: { name: 'asc' } },
    });
    return rows.map(toView);
  }

  async setRole(
    actorId: string,
    orgSlug: string,
    targetId: string,
    role: OrgRole,
  ): Promise<MemberView> {
    // Nobody re-ranks themselves: an owner stepping down is another owner's call, and an
    // admin could otherwise demote themselves out of the page they are on.
    if (actorId === targetId) throw new ForbiddenException({ code: 'own_role' });
    const organizationId = await this.change(
      actorId,
      orgSlug,
      targetId,
      role,
      async (tx, before) => {
        await tx.orgMember.update({
          where: {
            organizationId_userId: { organizationId: before.organizationId, userId: targetId },
          },
          data: { role },
        });
        await audit(tx, before.organizationId, actorId, 'org_member.role_changed', targetId, {
          before: before.role,
          after: role,
        });
      },
    );
    const row = await this.prisma.orgMember.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId, userId: targetId } },
      select: MEMBER,
    });
    return toView(row);
  }

  /**
   * Removal is the product's deactivation (R12.2): the membership row goes and every grant
   * the user holds in this org goes inert without being deleted. Their group memberships
   * in this org do go, so a later re-invite does not silently restore group access.
   */
  async remove(actorId: string, orgSlug: string, targetId: string): Promise<void> {
    await this.change(actorId, orgSlug, targetId, null, async (tx, before) => {
      const groups = await tx.groupMember.deleteMany({
        where: { userId: targetId, group: { organizationId: before.organizationId } },
      });
      await tx.orgMember.delete({
        where: {
          organizationId_userId: { organizationId: before.organizationId, userId: targetId },
        },
      });
      await audit(tx, before.organizationId, actorId, 'org_member.removed', targetId, {
        role: before.role,
        groupMembershipsRemoved: groups.count,
      });
    });
  }

  private async change(
    actorId: string,
    orgSlug: string,
    targetId: string,
    next: OrgRole | null,
    write: (
      tx: Prisma.TransactionClient,
      before: { organizationId: string; role: OrgRole },
    ) => Promise<void>,
  ): Promise<string> {
    const actor = await orgMembership(this.prisma, actorId, orgSlug);
    if (actor === null) throw new NotFoundException({ code: 'not_found' });
    assertRoleAdmin(actor.role);
    const { organizationId } = actor;

    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM organizations WHERE id = ${organizationId} FOR UPDATE`;
      // Both memberships re-read under the lock: the actor may have been demoted meanwhile.
      const [me, target, owners] = await Promise.all([
        tx.orgMember.findUnique({
          where: { organizationId_userId: { organizationId, userId: actorId } },
          select: { role: true },
        }),
        tx.orgMember.findUnique({
          where: { organizationId_userId: { organizationId, userId: targetId } },
          select: { role: true },
        }),
        tx.orgMember.count({ where: { organizationId, role: 'owner' } }),
      ]);
      if (target === null)
        throw new NotFoundException({
          code: 'not_found',
          resourceType: 'org_member',
          id: targetId,
        });
      assertMemberChange(me?.role ?? null, target.role, next, owners);
      await write(tx, { organizationId, role: target.role });
      await tx.user.update({ where: { id: targetId }, data: { permGeneration: { increment: 1 } } });
    });
    await this.resolver.invalidate({ user: targetId });
    return organizationId;
  }
}

const MEMBER = {
  role: true,
  joinedAt: true,
  user: { select: { id: true, name: true, email: true } },
} as const;

function toView(r: {
  role: OrgRole;
  joinedAt: Date;
  user: { id: string; name: string; email: string };
}): MemberView {
  return {
    userId: r.user.id,
    name: r.user.name,
    email: r.user.email,
    role: r.role,
    joinedAt: r.joinedAt.toISOString(),
  };
}

function audit(
  tx: Prisma.TransactionClient,
  organizationId: string,
  actorUserId: string,
  action: string,
  userId: string,
  metadata: Prisma.InputJsonValue,
): Promise<unknown> {
  return tx.auditLog.create({
    data: {
      organizationId,
      actorUserId,
      action,
      resourceType: 'user',
      resourceId: userId,
      metadata,
    },
  });
}
