import { randomBytes } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { OrgRole } from '@schemaloom/contracts';
import { hashInviteToken } from '../auth';
import type { Prisma } from '../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { orgMembership } from './members.service';
import { assertRoleAdmin } from './roles.service';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface PendingInvite {
  id: string;
  email: string;
  role: OrgRole;
  invitedBy: string | null;
  expiresAt: string;
}

/** Owners and admins invite; only an owner may invite an owner (the role-change rule). */
export function assertMayInvite(actor: OrgRole | null, role: OrgRole): void {
  assertRoleAdmin(actor);
  if (role === 'owner' && actor !== 'owner') {
    throw new ForbiddenException({ code: 'forbidden_org_role', required: ['owner'] });
  }
}

/**
 * Roadmap 16 §2 — org invites from Settings → Members. An org invite is an `Invitation`
 * row with no `accessGrantId`; the project-share invites (those with one) belong to their
 * Share dialog and are never listed or touched here. Accepting goes through the existing
 * `POST /invitations/:token/accept`.
 */
@Injectable()
export class MemberInvitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /** Not yet accepted or revoked; expired ones are listed so they can be re-sent. */
  async list(actorId: string, orgSlug: string): Promise<PendingInvite[]> {
    const { organizationId } = await this.admin(actorId, orgSlug);
    const rows = await this.prisma.invitation.findMany({
      where: { organizationId, ...PENDING_ORG_INVITE },
      select: INVITE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(toView);
  }

  /** A second invite to the same address replaces the first: new role, new link. */
  async create(
    actorId: string,
    orgSlug: string,
    rawEmail: string,
    role: OrgRole,
  ): Promise<PendingInvite> {
    const actor = await this.admin(actorId, orgSlug);
    assertMayInvite(actor.role, role);
    const email = rawEmail.trim().toLowerCase();
    const { organizationId } = actor;

    const member = await this.prisma.orgMember.findFirst({
      where: { organizationId, user: { email } },
      select: { userId: true },
    });
    if (member !== null) throw new ConflictException({ code: 'already_member' });

    const token = randomBytes(32).toString('base64url');
    const fresh = {
      orgRole: role,
      tokenHash: hashInviteToken(token),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      invitedById: actorId,
    };
    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.invitation.findFirst({
        where: { organizationId, email, ...PENDING_ORG_INVITE },
        select: { id: true },
      });
      const saved =
        existing === null
          ? await tx.invitation.create({
              data: { ...fresh, organizationId, email },
              select: INVITE,
            })
          : await tx.invitation.update({
              where: { id: existing.id },
              data: fresh,
              select: INVITE,
            });
      await audit(tx, organizationId, actorId, 'org_invitation.created', saved.id, { email, role });
      return saved;
    });
    await this.send(actorId, organizationId, email, token);
    return toView(row);
  }

  /** New link, new 7-day expiry; the old link stops working. */
  async resend(actorId: string, orgSlug: string, id: string): Promise<PendingInvite> {
    const { organizationId, invite } = await this.pending(actorId, orgSlug, id);
    const token = randomBytes(32).toString('base64url');
    const row = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.invitation.update({
        where: { id: invite.id },
        data: {
          tokenHash: hashInviteToken(token),
          expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        },
        select: INVITE,
      });
      await audit(tx, organizationId, actorId, 'org_invitation.resent', id, {
        email: invite.email,
      });
      return saved;
    });
    await this.send(actorId, organizationId, invite.email, token);
    return toView(row);
  }

  async revoke(actorId: string, orgSlug: string, id: string): Promise<void> {
    const { organizationId, invite } = await this.pending(actorId, orgSlug, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.invitation.update({ where: { id: invite.id }, data: { revokedAt: new Date() } });
      await audit(tx, organizationId, actorId, 'org_invitation.revoked', id, {
        email: invite.email,
      });
    });
  }

  private async admin(actorId: string, orgSlug: string) {
    const actor = await orgMembership(this.prisma, actorId, orgSlug);
    assertRoleAdmin(actor?.role ?? null);
    if (actor === null) throw new NotFoundException({ code: 'not_found' }); // unreachable
    return actor;
  }

  private async pending(actorId: string, orgSlug: string, id: string) {
    const actor = await this.admin(actorId, orgSlug);
    const invite = await this.prisma.invitation.findFirst({
      where: { id, organizationId: actor.organizationId, ...PENDING_ORG_INVITE },
      select: { id: true, email: true, orgRole: true },
    });
    if (invite === null) throw new NotFoundException({ code: 'not_found' });
    assertMayInvite(actor.role, invite.orgRole);
    return { organizationId: actor.organizationId, invite };
  }

  private async send(actorId: string, organizationId: string, email: string, token: string) {
    const [inviter, org] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({
        where: { id: actorId },
        select: { name: true, email: true },
      }),
      this.prisma.organization.findUniqueOrThrow({
        where: { id: organizationId },
        select: { name: true },
      }),
    ]);
    await this.mail.sendMemberInvitationEmail(
      email,
      inviter.name || inviter.email,
      org.name,
      token,
    );
  }
}

const PENDING_ORG_INVITE = { accessGrantId: null, acceptedAt: null, revokedAt: null } as const;

const INVITE = {
  id: true,
  email: true,
  orgRole: true,
  expiresAt: true,
  invitedBy: { select: { name: true, email: true } },
} as const;

function toView(r: {
  id: string;
  email: string;
  orgRole: OrgRole;
  expiresAt: Date;
  invitedBy: { name: string; email: string } | null;
}): PendingInvite {
  return {
    id: r.id,
    email: r.email,
    role: r.orgRole,
    invitedBy: r.invitedBy === null ? null : r.invitedBy.name || r.invitedBy.email,
    expiresAt: r.expiresAt.toISOString(),
  };
}

function audit(
  tx: Prisma.TransactionClient,
  organizationId: string,
  actorUserId: string,
  action: string,
  invitationId: string,
  metadata: Prisma.InputJsonValue,
): Promise<unknown> {
  return tx.auditLog.create({
    data: {
      organizationId,
      actorUserId,
      action,
      resourceType: 'invitation',
      resourceId: invitationId,
      metadata,
    },
  });
}
