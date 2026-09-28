import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BUILT_IN_ROLE_ORDER } from '@schemaloom/contracts';
import { PermissionResolver } from '../access';
import { PrincipalType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { lockProject, type Tx } from './access-write';
import { hashInviteToken } from './grants.service';

export interface InvitationView {
  organizationName: string;
  email: string;
  roleName: string | null;
}

export interface AcceptedInvitation {
  organizationId: string;
  orgSlug: string;
  projectId: string | null;
}

interface CollapsibleGrant {
  roleId: string;
  role: { key: string; isBuiltIn: boolean };
  canUseAi: boolean;
  canViewRestricted: boolean;
  expiresAt: Date | null;
}

/**
 * R11a (doc 05 §6.4) — collapse a pending invite grant `P` onto the user's existing grant
 * `E` on the same resource. Modifiers union; expiry is the longer of the two. Two
 * built-ins keep the higher in the R2 chain; a custom role on either side keeps `E`'s role
 * and asks for review — fail-closed, because "higher" is undefined for custom roles and
 * unioning their atoms would mint a role nobody approved.
 */
export function collapseGrants(
  existing: CollapsibleGrant,
  pending: CollapsibleGrant,
): {
  data: { roleId: string; canUseAi: boolean; canViewRestricted: boolean; expiresAt: Date | null };
  needsReview: boolean;
} {
  const order = BUILT_IN_ROLE_ORDER as readonly string[];
  const bothBuiltIn = existing.role.isBuiltIn && pending.role.isBuiltIn;
  const roleId =
    bothBuiltIn && order.indexOf(pending.role.key) > order.indexOf(existing.role.key)
      ? pending.roleId
      : existing.roleId;
  const expiresAt =
    existing.expiresAt === null || pending.expiresAt === null
      ? null
      : existing.expiresAt > pending.expiresAt
        ? existing.expiresAt
        : pending.expiresAt;
  return {
    data: {
      roleId,
      canUseAi: existing.canUseAi || pending.canUseAi,
      canViewRestricted: existing.canViewRestricted || pending.canViewRestricted,
      expiresAt,
    },
    needsReview: !bothBuiltIn,
  };
}

/**
 * Doc 05 §6.4 (R11) and §12.2(b). The token is the only credential here, so every dead
 * state — unknown, expired, revoked, accepted, org deleted — is the same `404`.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
  ) {}

  /** What the invite page needs to say, and nothing else: no project or resource name. */
  async view(token: string): Promise<InvitationView> {
    const inv = await this.live(this.prisma, token);
    const grant =
      inv.accessGrantId === null
        ? null
        : await this.prisma.accessGrant.findUnique({
            where: { id: inv.accessGrantId },
            select: { role: { select: { name: true } } },
          });
    return { organizationName: inv.organization.name, email: inv.email, roleName: grant?.role.name ?? null };
  }

  async accept(userId: string, token: string): Promise<AcceptedInvitation> {
    const found = await this.live(this.prisma, token);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    // The invite is matched on an email string, so the string must be proven first.
    if (user.emailVerifiedAt === null) throw new ForbiddenException({ code: 'email_not_verified' });
    if (user.email.toLowerCase() !== found.email) {
      throw new ForbiddenException({ code: 'invitation_email_mismatch', email: found.email });
    }

    const pendingRow =
      found.accessGrantId === null
        ? null
        : await this.prisma.accessGrant.findUnique({
            where: { id: found.accessGrantId },
            select: { projectId: true },
          });
    const projectId = pendingRow?.projectId ?? null;

    await this.prisma.$transaction(async (tx) => {
      if (projectId !== null) await lockProject(tx, projectId);
      // Re-read under the lock: two concurrent accepts serialise here, and the loser 404s.
      const inv = await this.live(tx, token);

      // 1. Membership FIRST (R11). Without it R12.2 kills the grant and the invitee lands
      //    on a 404. `update: {}` — an existing member is never downgraded to guest.
      await tx.orgMember.upsert({
        where: { organizationId_userId: { organizationId: inv.organizationId, userId } },
        update: {},
        create: { organizationId: inv.organizationId, userId, role: inv.orgRole },
      });

      // 2. Repoint the pending grant, or collapse it onto an existing one (R11a).
      const pending =
        inv.accessGrantId === null
          ? null
          : await tx.accessGrant.findUnique({
              where: { id: inv.accessGrantId },
              include: { role: { select: { key: true, isBuiltIn: true } } },
            });
      if (pending !== null) {
        const existing = await tx.accessGrant.findUnique({
          where: {
            resourceType_resourceId_principalType_principalId: {
              resourceType: pending.resourceType,
              resourceId: pending.resourceId,
              principalType: PrincipalType.user,
              principalId: userId,
            },
          },
          include: { role: { select: { key: true, isBuiltIn: true } } },
        });
        const audit = (action: string, metadata: object) =>
          tx.auditLog.create({
            data: {
              organizationId: pending.organizationId,
              projectId: pending.projectId,
              actorUserId: userId,
              action,
              resourceType: pending.resourceType,
              resourceId: pending.resourceId,
              metadata: { invitationId: inv.id, email: inv.email, ...metadata },
            },
          });

        if (existing === null) {
          await tx.accessGrant.update({
            where: { id: pending.id },
            data: { principalType: PrincipalType.user, principalId: userId },
          });
          await audit('grant.invite_converted', { grantId: pending.id });
        } else {
          const merged = collapseGrants(existing, pending);
          // The invitation row cascades off the pending grant; unlink it first so the
          // acceptance record survives the delete.
          await tx.invitation.update({ where: { id: inv.id }, data: { accessGrantId: null } });
          await tx.accessGrant.update({ where: { id: existing.id }, data: merged.data });
          await tx.accessGrant.delete({ where: { id: pending.id } });
          if (merged.needsReview) {
            await audit('grant.invite_merge_review', {
              grantId: existing.id,
              keptRoleKey: existing.role.key,
              notAppliedRoleKey: pending.role.key,
            });
          }
          await audit('grant.invite_converted', { grantId: existing.id, mergedFrom: pending.id });
        }
      }

      await tx.invitation.update({
        where: { id: inv.id },
        data: { acceptedAt: new Date(), acceptedByUserId: userId },
      });
      await tx.user.update({ where: { id: userId }, data: { permGeneration: { increment: 1 } } });
    });
    await this.resolver.invalidate({ user: userId, ...(projectId === null ? {} : { project: projectId }) });

    return { organizationId: found.organizationId, orgSlug: found.organization.slug, projectId };
  }

  private async live(db: Tx | PrismaService, token: string) {
    const inv = await db.invitation.findUnique({
      where: { tokenHash: hashInviteToken(token) },
      include: { organization: { select: { name: true, slug: true, deletedAt: true } } },
    });
    if (
      inv?.acceptedAt !== null ||
      inv.revokedAt !== null ||
      inv.expiresAt <= new Date() ||
      inv.organization.deletedAt !== null
    ) {
      throw new NotFoundException({ code: 'not_found' });
    }
    return inv;
  }
}
