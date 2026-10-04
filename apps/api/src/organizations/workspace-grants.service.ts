import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PermissionResolver } from '../access';
import { materialise } from '../access/atoms';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { assertNotGuestManager, grantableRole } from '../sharing/access-write';

/** Roadmap 19 — one row of a workspace's Share dialog. */
export interface WorkspaceGrantView {
  readonly id: string;
  readonly principalKind: 'user' | 'group';
  readonly principalId: string;
  /** a user's name, or a group's */
  readonly principalName: string;
  readonly principalEmail: string | null;
  readonly roleKey: string;
  readonly roleName: string;
  readonly canUseAi: boolean;
  readonly canViewRestricted: boolean;
  readonly expiresAt: string | null;
}

export interface WorkspaceGrantInput {
  readonly principalKind: 'user' | 'group';
  readonly principalId: string;
  readonly roleKey: string;
  readonly canUseAi: boolean;
  readonly canViewRestricted: boolean;
  readonly expiresAt?: string | null | undefined;
}

const SELECT = {
  id: true,
  principalType: true,
  principalId: true,
  canUseAi: true,
  canViewRestricted: true,
  expiresAt: true,
  roleId: true,
  role: { select: { key: true, name: true } },
} satisfies Prisma.WorkspaceGrantSelect;

type Row = Prisma.WorkspaceGrantGetPayload<{ select: typeof SELECT }>;

/**
 * Roadmap 19 (`docs/phase19/DESIGN.md`) — grants on a whole workspace. Org owners only (Q2):
 * an admin sees only the projects they're granted (R13), and a workspace grant would let
 * them grant themselves every project in it. Every write bumps the org generation (Q4),
 * which retires every cached permission map in the org at commit.
 */
@Injectable()
export class WorkspaceGrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
  ) {}

  private async ownedWorkspace(
    userId: string,
    orgSlug: string,
    workspaceId: string,
  ): Promise<{ organizationId: string; name: string }> {
    const member = await this.prisma.orgMember.findFirst({
      where: { userId, organization: { slug: orgSlug, deletedAt: null } },
      select: { organizationId: true, role: true },
    });
    if (member === null) throw new NotFoundException({ code: 'not_found' });
    if (member.role !== 'owner')
      throw new ForbiddenException({ code: 'forbidden_org_role', required: ['owner'] });
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, organizationId: member.organizationId },
      select: { name: true },
    });
    if (workspace === null) throw new NotFoundException({ code: 'not_found' });
    return { organizationId: member.organizationId, name: workspace.name };
  }

  async list(userId: string, orgSlug: string, workspaceId: string): Promise<WorkspaceGrantView[]> {
    await this.ownedWorkspace(userId, orgSlug, workspaceId);
    const rows = await this.prisma.workspaceGrant.findMany({
      where: { workspaceId },
      select: SELECT,
      orderBy: { createdAt: 'asc' },
    });
    return this.views(rows);
  }

  /** Same pair again updates it, as `POST /projects/:id/grants` does (R10). */
  async upsert(
    userId: string,
    orgSlug: string,
    workspaceId: string,
    input: WorkspaceGrantInput,
  ): Promise<WorkspaceGrantView> {
    const { organizationId, name } = await this.ownedWorkspace(userId, orgSlug, workspaceId);
    await this.assertPrincipalInOrg(input.principalKind, input.principalId, organizationId);
    const role = await grantableRole(this.prisma, organizationId, input.roleKey);
    const expiresAt = parseExpiry(input.expiresAt);

    const row = await this.prisma.$transaction(async (tx) => {
      await assertNotGuestManager(
        tx,
        organizationId,
        { type: input.principalKind, id: input.principalId },
        materialise({
          atoms: role.atoms,
          canUseAi: input.canUseAi,
          canViewRestricted: input.canViewRestricted,
        }),
      );
      const key = {
        workspaceId,
        principalType: input.principalKind,
        principalId: input.principalId,
      };
      const before = await tx.workspaceGrant.findUnique({
        where: { workspaceId_principalType_principalId: key },
        select: SELECT,
      });
      const modifiers = {
        roleId: role.id,
        canUseAi: input.canUseAi,
        canViewRestricted: input.canViewRestricted,
        expiresAt,
      };
      const after = await tx.workspaceGrant.upsert({
        where: { workspaceId_principalType_principalId: key },
        update: modifiers,
        create: { ...key, ...modifiers, organizationId, createdById: userId },
        select: SELECT,
      });
      await bumpOrg(tx, organizationId);
      await audit(
        tx,
        organizationId,
        userId,
        before === null ? 'workspace_grant.created' : 'workspace_grant.updated',
        after.id,
        {
          workspaceId,
          workspaceName: name,
          before: before === null ? null : snapshot(before),
          after: snapshot(after),
        },
      );
      return after;
    });
    await this.resolver.invalidate({ org: organizationId });
    const [view] = await this.views([row]);
    if (view === undefined) throw new NotFoundException({ code: 'not_found' });
    return view;
  }

  async remove(userId: string, orgSlug: string, grantId: string): Promise<void> {
    const grant = await this.prisma.workspaceGrant.findUnique({
      where: { id: grantId },
      select: { ...SELECT, workspaceId: true },
    });
    if (grant === null) throw new NotFoundException({ code: 'not_found' });
    const { organizationId } = await this.ownedWorkspace(userId, orgSlug, grant.workspaceId);
    await this.prisma.$transaction(async (tx) => {
      await tx.workspaceGrant.delete({ where: { id: grantId } });
      await bumpOrg(tx, organizationId);
      await audit(tx, organizationId, userId, 'workspace_grant.deleted', grantId, {
        workspaceId: grant.workspaceId,
        before: snapshot(grant),
      });
    });
    await this.resolver.invalidate({ org: organizationId });
  }

  private async assertPrincipalInOrg(
    kind: 'user' | 'group',
    id: string,
    organizationId: string,
  ): Promise<void> {
    const found =
      kind === 'user'
        ? await this.prisma.orgMember.findUnique({
            where: { organizationId_userId: { organizationId, userId: id } },
            select: { id: true },
          })
        : await this.prisma.userGroup.findFirst({
            where: { id, organizationId },
            select: { id: true },
          });
    if (found === null) throw new BadRequestException({ code: 'unknown_principal' });
  }

  private async views(rows: readonly Row[]): Promise<WorkspaceGrantView[]> {
    const userIds = rows.filter((r) => r.principalType === 'user').map((r) => r.principalId);
    const groupIds = rows.filter((r) => r.principalType === 'group').map((r) => r.principalId);
    const [users, groups] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, email: true },
      }),
      this.prisma.userGroup.findMany({
        where: { id: { in: groupIds } },
        select: { id: true, name: true },
      }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const groupById = new Map(groups.map((g) => [g.id, g]));
    return rows.map((r) => {
      const user = r.principalType === 'user' ? userById.get(r.principalId) : undefined;
      return {
        id: r.id,
        principalKind: r.principalType === 'group' ? 'group' : 'user',
        principalId: r.principalId,
        principalName: user?.name ?? groupById.get(r.principalId)?.name ?? r.principalId,
        principalEmail: user?.email ?? null,
        roleKey: r.role.key,
        roleName: r.role.name,
        canUseAi: r.canUseAi,
        canViewRestricted: r.canViewRestricted,
        expiresAt: r.expiresAt?.toISOString() ?? null,
      };
    });
  }
}

function parseExpiry(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const at = new Date(value);
  if (at.getTime() <= Date.now()) throw new BadRequestException({ code: 'expiry_in_past' });
  return at;
}

function snapshot(r: Row): Prisma.InputJsonValue {
  return {
    principalType: r.principalType,
    principalId: r.principalId,
    roleId: r.roleId,
    canUseAi: r.canUseAi,
    canViewRestricted: r.canViewRestricted,
    expiresAt: r.expiresAt?.toISOString() ?? null,
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
  grantId: string,
  metadata: Prisma.InputJsonValue,
): Promise<unknown> {
  return tx.auditLog.create({
    data: {
      organizationId,
      actorUserId,
      action,
      resourceType: 'workspace_grant',
      resourceId: grantId,
      metadata,
    },
  });
}
