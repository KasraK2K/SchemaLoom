import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { OrgRole } from '@schemaloom/contracts';
import { PermissionResolver } from '../access';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Doc 05 §3.2 — org administration (members, groups, custom roles) is owners and admins. A
 * non-member gets the same 404 as a missing org. Lives here, not in `roles.service`, so the
 * auth module can reach the members and groups services without importing the whole org graph.
 */
export function assertRoleAdmin(orgRole: OrgRole | null): void {
  if (orgRole === null) throw new NotFoundException({ code: 'not_found' });
  if (orgRole !== 'owner' && orgRole !== 'admin') {
    throw new ForbiddenException({ code: 'forbidden_org_role', required: ['owner', 'admin'] });
  }
}

/** Roadmap 14b: a change the IdP made, audited with no actor and `metadata.via`. */
export type DirectoryVia = 'scim' | 'sso';

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
 * Roadmap 14b §1.3 (Q3): the IdP never deprovisions an owner. Owners are the break-glass
 * accounts, the same rule as SSO enforcement; demote in SchemaLoom first.
 */
export function assertDirectoryMayRemove(target: OrgRole): void {
  if (target === 'owner')
    throw new ConflictException({
      code: 'owner_protected',
      message: 'Remove the owner role in SchemaLoom first.',
    });
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
    const organizationId = await this.adminOrg(actorId, orgSlug);
    await this.change(
      organizationId,
      targetId,
      (tx, target, owners) => assertActor(tx, organizationId, actorId, target, role, owners),
      async (tx, before) => {
        await tx.orgMember.update({
          where: { organizationId_userId: { organizationId, userId: targetId } },
          data: { role },
        });
        await audit(tx, organizationId, actorId, 'org_member.role_changed', targetId, {
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
    const organizationId = await this.adminOrg(actorId, orgSlug);
    await this.change(
      organizationId,
      targetId,
      (tx, target, owners) => assertActor(tx, organizationId, actorId, target, null, owners),
      (tx, before) => removeRows(tx, organizationId, targetId, before.role, actorId, {}),
    );
  }

  /**
   * Roadmap 14b §1.3 — the IdP deprovisions someone: the same removal as `remove`, with no
   * actor. Owners are refused (`assertDirectoryMayRemove`), checked under the org lock so a
   * concurrent promotion can't slip past it. `false` when the user wasn't a member.
   */
  async removeByDirectory(
    organizationId: string,
    targetId: string,
    via: DirectoryVia,
    extra: Record<string, string | boolean> = {},
  ): Promise<boolean> {
    const member = await this.prisma.orgMember.findUnique({
      where: { organizationId_userId: { organizationId, userId: targetId } },
      select: { id: true },
    });
    if (member === null) return false;
    await this.change(
      organizationId,
      targetId,
      (_tx, target) => {
        assertDirectoryMayRemove(target);
        return Promise.resolve();
      },
      (tx, before) =>
        removeRows(tx, organizationId, targetId, before.role, null, { ...extra, via }),
    );
    return true;
  }

  /**
   * Roadmap 14b §1.3 — the IdP (re)activates someone: they join with the connection's
   * default role. Old grants come back to life, as for any re-added member (R12.2), so this
   * bumps `permGeneration` like every membership change. `false` when already a member.
   */
  async addByDirectory(
    organizationId: string,
    userId: string,
    role: OrgRole,
    scimExternalId: string | null,
    via: DirectoryVia,
  ): Promise<boolean> {
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.orgMember.create({ data: { organizationId, userId, role, scimExternalId } });
        await tx.user.update({ where: { id: userId }, data: { permGeneration: { increment: 1 } } });
        await audit(tx, organizationId, null, 'org_member.added', userId, { role, via });
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === 'P2002') return false;
      throw error;
    }
    await this.resolver.invalidate({ user: userId });
    return true;
  }

  private async adminOrg(actorId: string, orgSlug: string): Promise<string> {
    const actor = await orgMembership(this.prisma, actorId, orgSlug);
    if (actor === null) throw new NotFoundException({ code: 'not_found' });
    assertRoleAdmin(actor.role);
    return actor.organizationId;
  }

  /**
   * One membership change: the org row locked, the target re-read under the lock, `check`
   * (may this happen), `write`, and the target's `permGeneration` bumped in the same
   * transaction; then the resolver's cache is invalidated.
   */
  private async change(
    organizationId: string,
    targetId: string,
    check: (tx: Prisma.TransactionClient, target: OrgRole, owners: number) => Promise<void>,
    write: (tx: Prisma.TransactionClient, before: { role: OrgRole }) => Promise<void>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT 1 FROM organizations WHERE id = ${organizationId} FOR UPDATE`;
      const [target, owners] = await Promise.all([
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
      await check(tx, target.role, owners);
      await write(tx, { role: target.role });
      await tx.user.update({ where: { id: targetId }, data: { permGeneration: { increment: 1 } } });
    });
    await this.resolver.invalidate({ user: targetId });
  }
}

/** The actor's membership re-read under the lock: they may have been demoted meanwhile. */
async function assertActor(
  tx: Prisma.TransactionClient,
  organizationId: string,
  actorId: string,
  target: OrgRole,
  next: OrgRole | null,
  owners: number,
): Promise<void> {
  const me = await tx.orgMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: actorId } },
    select: { role: true },
  });
  assertMemberChange(me?.role ?? null, target, next, owners);
}

async function removeRows(
  tx: Prisma.TransactionClient,
  organizationId: string,
  targetId: string,
  role: OrgRole,
  actorId: string | null,
  extra: Record<string, string | boolean>,
): Promise<void> {
  const groups = await tx.groupMember.deleteMany({
    where: { userId: targetId, group: { organizationId } },
  });
  await tx.orgMember.delete({
    where: { organizationId_userId: { organizationId, userId: targetId } },
  });
  await audit(tx, organizationId, actorId, 'org_member.removed', targetId, {
    role,
    groupMembershipsRemoved: groups.count,
    ...extra,
  });
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
  actorUserId: string | null,
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
