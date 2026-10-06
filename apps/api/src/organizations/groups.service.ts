import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PermissionResolver } from '../access';
import { PrincipalType } from '../generated/prisma/enums';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertMayList,
  assertRoleAdmin,
  orgMembership,
  type DirectoryVia,
} from './members.service';
import type { CreateGroupDto, UpdateGroupDto } from './organizations.dto';

const UNIQUE_VIOLATION = 'P2002';

/** Roadmap 14b: who fills a group. `null` is a group people manage here. */
export type GroupManagedBy = 'scim' | 'claim';

export interface GroupView {
  id: string;
  name: string;
  description: string | null;
  managedBy: GroupManagedBy | null;
  members: { userId: string; name: string; email: string }[];
}

/** Who made a membership change: a person, or the IdP (no actor, `metadata.via`). */
type Actor = { readonly userId: string } | { readonly via: DirectoryVia };

/**
 * Doc 05 §3.2 user groups (the `group` grant principal). Listing is owner/admin/member,
 * every write owner/admin. Invalidation is §9.3's: create/delete bump
 * `Organization.permGeneration`; one membership change bumps that user's counter; a rename
 * changes nobody's access and bumps nothing. Every write is audited in its transaction.
 *
 * Roadmap 14b §1.4: a group the IdP fills (`managedBy`) is read-only to people (no rename,
 * no member edits); it can still be granted access. The `*ByDirectory` methods are the
 * IdP's way in, with the same transactions, bumps and audit rows.
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
    return this.insert(
      organizationId,
      { userId },
      { name: dto.name, description: dto.description },
    );
  }

  async update(
    userId: string,
    orgSlug: string,
    groupId: string,
    dto: UpdateGroupDto,
  ): Promise<GroupView> {
    const organizationId = await this.admin(userId, orgSlug);
    assertUnmanaged(await this.group(organizationId, groupId));
    return this.rename(organizationId, groupId, { userId }, dto);
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
      // Roadmap 19: its workspace grants go with it.
      await tx.workspaceGrant.deleteMany({ where });
      await tx.userGroup.delete({ where: { id: groupId } });
      await bumpOrg(tx, organizationId);
      await audit(tx, organizationId, { userId }, 'group.deleted', groupId, {
        name: group.name,
        memberIds: group.members.map((m) => m.user.id),
        grantsRemoved: grants,
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
    assertUnmanaged(await this.group(organizationId, groupId));
    if (!(await this.join(organizationId, groupId, userId, { userId: actorId })))
      throw new NotFoundException({ code: 'not_found', resourceType: 'org_member', id: userId });
    return toView(await this.group(organizationId, groupId));
  }

  async removeMember(
    actorId: string,
    orgSlug: string,
    groupId: string,
    userId: string,
  ): Promise<void> {
    const organizationId = await this.admin(actorId, orgSlug);
    assertUnmanaged(await this.group(organizationId, groupId));
    if (!(await this.leave(organizationId, groupId, userId, { userId: actorId })))
      throw new NotFoundException({
        code: 'not_found',
        resourceType: 'group_member',
        id: userId,
      });
  }

  // ------------------------------------------------------- roadmap 14b: the IdP's way in

  /** SCIM `POST /Groups`. A name already taken is 409 `group_name_taken`, as for people. */
  createByDirectory(
    organizationId: string,
    name: string,
    scimExternalId: string | null,
  ): Promise<GroupView> {
    return this.insert(
      organizationId,
      { via: 'scim' },
      { name, managedBy: 'scim', scimExternalId },
    );
  }

  renameByDirectory(
    organizationId: string,
    groupId: string,
    data: { name?: string; scimExternalId?: string | null },
  ): Promise<GroupView> {
    return this.rename(organizationId, groupId, { via: 'scim' }, data);
  }

  /** Adds an org member; `false` when the user isn't in the org (SCIM skips them, §1.4). */
  addMemberByDirectory(
    organizationId: string,
    groupId: string,
    userId: string,
    via: DirectoryVia,
  ): Promise<boolean> {
    return this.join(organizationId, groupId, userId, { via });
  }

  /** Idempotent: `false` when they weren't in it. */
  removeMemberByDirectory(
    organizationId: string,
    groupId: string,
    userId: string,
    via: DirectoryVia,
  ): Promise<boolean> {
    return this.leave(organizationId, groupId, userId, { via });
  }

  /**
   * §1.4 / Q4 — the IdP deleted the group: empty it and hand it back to people as a normal
   * group. It is NOT deleted: its grants would go with it, and unassigning a group in the
   * IdP shouldn't silently wipe a project's sharing. Each removed member's counter is
   * bumped, as for any membership change.
   */
  async releaseByDirectory(organizationId: string, groupId: string): Promise<void> {
    const group = await this.group(organizationId, groupId);
    const memberIds = group.members.map((m) => m.user.id);
    await this.prisma.$transaction(async (tx) => {
      await tx.groupMember.deleteMany({ where: { groupId } });
      if (memberIds.length > 0)
        await tx.user.updateMany({
          where: { id: { in: memberIds } },
          data: { permGeneration: { increment: 1 } },
        });
      await tx.userGroup.update({
        where: { id: groupId },
        data: { managedBy: null, scimExternalId: null },
      });
      await audit(tx, organizationId, { via: 'scim' }, 'group.released', groupId, {
        name: group.name,
        memberIds,
      });
    });
    await Promise.all(memberIds.map((user) => this.resolver.invalidate({ user })));
  }

  // ------------------------------------------------------------------------ internals

  private async insert(
    organizationId: string,
    actor: Actor,
    data: {
      name: string;
      description?: string | null | undefined;
      managedBy?: GroupManagedBy;
      scimExternalId?: string | null;
    },
  ): Promise<GroupView> {
    await this.assertNameFree(organizationId, data.name, null);
    const group = await this.prisma.$transaction(async (tx) => {
      const row = await tx.userGroup.create({
        data: {
          organizationId,
          name: data.name,
          description: data.description ?? null,
          managedBy: data.managedBy ?? null,
          scimExternalId: data.scimExternalId ?? null,
        },
        select: GROUP,
      });
      await bumpOrg(tx, organizationId);
      await audit(tx, organizationId, actor, 'group.created', row.id, { name: row.name });
      return row;
    });
    await this.resolver.invalidate({ org: organizationId });
    return toView(group);
  }

  private async rename(
    organizationId: string,
    groupId: string,
    actor: Actor,
    data: {
      name?: string | undefined;
      description?: string | null | undefined;
      scimExternalId?: string | null;
    },
  ): Promise<GroupView> {
    const before = await this.group(organizationId, groupId);
    if (data.name !== undefined) await this.assertNameFree(organizationId, data.name, groupId);
    const group = await this.prisma.$transaction(async (tx) => {
      const row = await tx.userGroup.update({
        where: { id: groupId },
        data: {
          name: data.name,
          description: data.description,
          scimExternalId: data.scimExternalId,
        },
        select: GROUP,
      });
      if (row.name !== before.name || row.description !== before.description)
        await audit(tx, organizationId, actor, 'group.updated', groupId, {
          before: { name: before.name, description: before.description },
          after: { name: row.name, description: row.description },
        });
      return row;
    });
    return toView(group);
  }

  /** `false` when the user isn't an org member. Already in the group is success. */
  private async join(
    organizationId: string,
    groupId: string,
    userId: string,
    actor: Actor,
  ): Promise<boolean> {
    const target = await this.prisma.orgMember.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { userId: true },
    });
    if (target === null) return false;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.groupMember.create({ data: { groupId, userId } });
        await tx.user.update({ where: { id: userId }, data: { permGeneration: { increment: 1 } } });
        await audit(tx, organizationId, actor, 'group.member_added', groupId, { userId });
      });
      await this.resolver.invalidate({ user: userId });
    } catch (error) {
      if ((error as { code?: unknown }).code !== UNIQUE_VIOLATION) throw error;
    }
    return true;
  }

  /** `false` when they weren't in the group (nothing written). */
  private async leave(
    organizationId: string,
    groupId: string,
    userId: string,
    actor: Actor,
  ): Promise<boolean> {
    const removed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.groupMember.deleteMany({ where: { groupId, userId } });
      if (count === 0) return false;
      await tx.user.update({ where: { id: userId }, data: { permGeneration: { increment: 1 } } });
      await audit(tx, organizationId, actor, 'group.member_removed', groupId, { userId });
      return true;
    });
    if (removed) await this.resolver.invalidate({ user: userId });
    return removed;
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

/** §1.4: people don't edit what the IdP fills; the next sync would undo it anyway. */
function assertUnmanaged(group: { managedBy: string | null }): void {
  if (group.managedBy !== null)
    throw new ConflictException({ code: 'group_managed', managedBy: group.managedBy });
}

const GROUP = {
  id: true,
  name: true,
  description: true,
  managedBy: true,
  members: {
    select: { user: { select: { id: true, name: true, email: true } } },
    orderBy: { user: { name: 'asc' } },
  },
} as const;

export function toView(g: {
  id: string;
  name: string;
  description: string | null;
  managedBy: string | null;
  members: { user: { id: string; name: string; email: string } }[];
}): GroupView {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    managedBy: g.managedBy === 'scim' || g.managedBy === 'claim' ? g.managedBy : null,
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
  actor: Actor,
  action: string,
  groupId: string,
  metadata: Record<string, Prisma.InputJsonValue>,
): Promise<unknown> {
  return tx.auditLog.create({
    data: {
      organizationId,
      actorUserId: 'userId' in actor ? actor.userId : null,
      action,
      resourceType: 'group',
      resourceId: groupId,
      metadata: 'via' in actor ? { ...metadata, via: actor.via } : metadata,
    },
  });
}
