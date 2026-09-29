import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PermissionResolver } from '../access';
import { PrincipalType } from '../generated/prisma/enums';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertMayList, orgMembership } from './members.service';
import { assertRoleAdmin } from './roles.service';
import type { CreateGroupDto, UpdateGroupDto } from './organizations.dto';

const UNIQUE_VIOLATION = 'P2002';

export interface GroupView {
  id: string;
  name: string;
  description: string | null;
  members: { userId: string; name: string; email: string }[];
}

/**
 * Doc 05 §3.2 user groups (the `group` grant principal). Listing is owner/admin/member,
 * every write owner/admin. Invalidation is §9.3's: create/delete bump
 * `Organization.permGeneration`; one membership change bumps that user's counter; a rename
 * changes nobody's access and bumps nothing. Every write is audited in its transaction.
 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
  ) {}

  async list(userId: string, orgSlug: string): Promise<GroupView[]> {
    const member = await orgMembership(this.prisma, userId, orgSlug);
    assertMayList(member?.role ?? null);
    if (member === null) return []; // unreachable: assertMayList 404s it
    const rows = await this.prisma.userGroup.findMany({
      where: { organizationId: member.organizationId },
      select: GROUP,
      orderBy: { name: 'asc' },
    });
    return rows.map(toView);
  }

  async create(userId: string, orgSlug: string, dto: CreateGroupDto): Promise<GroupView> {
    const organizationId = await this.admin(userId, orgSlug);
    await this.assertNameFree(organizationId, dto.name, null);
    const group = await this.prisma.$transaction(async (tx) => {
      const row = await tx.userGroup.create({
        data: { organizationId, name: dto.name, description: dto.description ?? null },
        select: GROUP,
      });
      await bumpOrg(tx, organizationId);
      await audit(tx, organizationId, userId, 'group.created', row.id, { name: row.name });
      return row;
    });
    await this.resolver.invalidate({ org: organizationId });
    return toView(group);
  }

  async update(
    userId: string,
    orgSlug: string,
    groupId: string,
    dto: UpdateGroupDto,
  ): Promise<GroupView> {
    const organizationId = await this.admin(userId, orgSlug);
    const before = await this.group(organizationId, groupId);
    if (dto.name !== undefined) await this.assertNameFree(organizationId, dto.name, groupId);
    const group = await this.prisma.$transaction(async (tx) => {
      const row = await tx.userGroup.update({
        where: { id: groupId },
        data: { name: dto.name, description: dto.description },
        select: GROUP,
      });
      await audit(tx, organizationId, userId, 'group.updated', groupId, {
        before: { name: before.name, description: before.description },
        after: { name: row.name, description: row.description },
      });
      return row;
    });
    return toView(group);
  }

  /**
   * Memberships cascade. The group's grants have no FK to it (`principalId` is a string),
   * so they are deleted here with their before-image in the audit row, as area deletion
   * does (doc 05 §10.5) — a grant whose principal no longer exists is dead weight.
   */
  async remove(userId: string, orgSlug: string, groupId: string): Promise<void> {
    const organizationId = await this.admin(userId, orgSlug);
    const group = await this.group(organizationId, groupId);
    await this.prisma.$transaction(async (tx) => {
      const where = { organizationId, principalType: PrincipalType.group, principalId: groupId };
      const grants = await tx.accessGrant.findMany({
        where,
        select: { id: true, projectId: true, resourceType: true, resourceId: true, roleId: true },
      });
      await tx.accessGrant.deleteMany({ where });
      await tx.userGroup.delete({ where: { id: groupId } });
      await bumpOrg(tx, organizationId);
      await audit(tx, organizationId, userId, 'group.deleted', groupId, {
        name: group.name,
        memberIds: group.members.map((m) => m.user.id),
        grantsRemoved: grants as unknown as Prisma.InputJsonValue,
      });
    });
    await this.resolver.invalidate({ org: organizationId });
  }

  /** Idempotent. The user must already belong to the org; a guest may (doc 05 §3.2). */
  async addMember(
    actorId: string,
    orgSlug: string,
    groupId: string,
    userId: string,
  ): Promise<GroupView> {
    const organizationId = await this.admin(actorId, orgSlug);
    await this.group(organizationId, groupId);
    const target = await this.prisma.orgMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { userId: true },
    });
    if (target === null)
      throw new NotFoundException({ code: 'not_found', resourceType: 'org_member', id: userId });
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.groupMember.create({ data: { groupId, userId } });
        await tx.user.update({ where: { id: userId }, data: { permGeneration: { increment: 1 } } });
        await audit(tx, organizationId, actorId, 'group.member_added', groupId, { userId });
      });
      await this.resolver.invalidate({ user: userId });
    } catch (error) {
      if ((error as { code?: unknown }).code !== UNIQUE_VIOLATION) throw error;
    }
    return toView(await this.group(organizationId, groupId));
  }

  async removeMember(
    actorId: string,
    orgSlug: string,
    groupId: string,
    userId: string,
  ): Promise<void> {
    const organizationId = await this.admin(actorId, orgSlug);
    await this.group(organizationId, groupId);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.groupMember.deleteMany({ where: { groupId, userId } });
      if (count === 0)
        throw new NotFoundException({
          code: 'not_found',
          resourceType: 'group_member',
          id: userId,
        });
      await tx.user.update({ where: { id: userId }, data: { permGeneration: { increment: 1 } } });
      await audit(tx, organizationId, actorId, 'group.member_removed', groupId, { userId });
    });
    await this.resolver.invalidate({ user: userId });
  }

  private async admin(userId: string, orgSlug: string): Promise<string> {
    const member = await orgMembership(this.prisma, userId, orgSlug);
    if (member === null) throw new NotFoundException({ code: 'not_found' });
    assertRoleAdmin(member.role);
    return member.organizationId;
  }

  private async group(organizationId: string, groupId: string) {
    const group = await this.prisma.userGroup.findFirst({
      where: { id: groupId, organizationId },
      select: GROUP,
    });
    if (group === null)
      throw new NotFoundException({ code: 'not_found', resourceType: 'group', id: groupId });
    return group;
  }

  /** No DB constraint backs this (doc 02 has none on `user_groups.name`); two groups with
   *  one name would make the access dialog ambiguous. ponytail: check-then-write. */
  private async assertNameFree(
    organizationId: string,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    const clash = await this.prisma.userGroup.findFirst({
      where: {
        organizationId,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId === null ? {} : { id: { not: exceptId } }),
      },
      select: { id: true },
    });
    if (clash !== null) throw new ConflictException({ code: 'group_name_taken' });
  }
}

const GROUP = {
  id: true,
  name: true,
  description: true,
  members: {
    select: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { user: { name: 'asc' } },
  },
} as const;

function toView(g: {
  id: string;
  name: string;
  description: string | null;
  members: { user: { id: string; name: string; email: string } }[];
}): GroupView {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    members: g.members.map((m) => ({ userId: m.user.id, name: m.user.name, email: m.user.email })),
  };
}

function bumpOrg(tx: Prisma.TransactionClient, organizationId: string): Promise<unknown> {
  return tx.organization.update({
    where: { id: organizationId },
    data: { permGeneration: { increment: 1 } },
  });
}

function audit(
  tx: Prisma.TransactionClient,
  organizationId: string,
  actorUserId: string,
  action: string,
  groupId: string,
  metadata: Prisma.InputJsonValue,
): Promise<unknown> {
  return tx.auditLog.create({
    data: {
      organizationId,
      actorUserId,
      action,
      resourceType: 'group',
      resourceId: groupId,
      metadata,
    },
  });
}
