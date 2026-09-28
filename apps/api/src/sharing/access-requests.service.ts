import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import {
  PermissionResolver,
  atomsAt,
  materialise,
  splitPrincipalKey,
  type ProjectPermissionMap,
  type ResourceRef,
  type Subject,
} from '../access';
import { Prisma } from '../generated/prisma/client';
import { AccessRequestStatus, PrincipalType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_RATELIMIT } from '../redis/redis.tokens';
import { AccessWriter, assertNotGuestManager, assertVisible, grantableRole, type Tx } from './access-write';
import type { RequestAccessDto } from './sharing.dto';

type UserSubject = Subject & { kind: 'user' };

export interface AccessRequestView {
  id: string;
  requesterLabel: string;
  requesterEmail: string | null;
  resourceType: ResourceRef['type'];
  resourceId: string;
  resourceName: string;
  requestedRoleKey: string | null;
  message: string | null;
  createdAt: string;
}

/** §7.13 — one NEW request per (resource, requester) per 24 h, on top of the pending index. */
const REQUEST_WINDOW_SEC = 24 * 60 * 60;
/** §7.13 — stop a 200-person org from being paged by one request. */
const MAX_RECIPIENTS = 25;

/**
 * Doc 05 §7.13. The create endpoint is a NON-ORACLE: it answers 202 for a project that
 * does not exist, one in another org, one you already hold and one you asked for an hour
 * ago, and writes a row only when the target is real and in the requester's org.
 */
@Injectable()
export class AccessRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    private readonly writer: AccessWriter,
    @Inject(REDIS_RATELIMIT) private readonly rateLimit: Redis,
  ) {}

  /** Never throws for a bad target and never says which case it was. */
  async request(subject: UserSubject, body: RequestAccessDto): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: { id: body.projectId, organizationId: subject.orgId, deletedAt: null },
      select: { id: true, organizationId: true },
    });
    if (project === null) return;
    const ref = { type: body.resourceType, id: body.resourceId };
    if (!(await this.exists(project.id, ref))) return;

    // Fails closed (redis.tokens.ts): a Redis error propagates rather than admitting.
    const window = await this.rateLimit.set(
      `access-request:${ref.type}:${ref.id}:${subject.userId}`,
      '1',
      'EX',
      REQUEST_WINDOW_SEC,
      'NX',
    );
    if (window === null) return;

    const role = body.requestedRoleKey === undefined
      ? null
      : await this.prisma.role.findFirst({
          where: {
            key: body.requestedRoleKey,
            isArchived: false,
            OR: [{ organizationId: null, isBuiltIn: true }, { organizationId: project.organizationId }],
          },
          select: { id: true },
        });

    let requestId: string;
    try {
      const row = await this.prisma.accessRequest.create({
        data: {
          projectId: project.id,
          resourceType: ref.type,
          resourceId: ref.id,
          requesterId: subject.userId,
          requestedRoleId: role?.id ?? null,
          message: body.message ?? null,
        },
      });
      requestId = row.id;
    } catch (error) {
      // `access_requests_pending_uq`: one OPEN request per (resource, requester).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }

    await this.prisma.$transaction(async (tx) => {
      await this.writer.audit(tx, subject, project.id, project.organizationId, {
        action: 'access_request.created',
        resourceType: ref.type,
        resourceId: ref.id,
        metadata: { accessRequestId: requestId },
      });
      const recipients = await this.approvers(project.id, project.organizationId, ref, subject.userId);
      await tx.notification.createMany({
        data: recipients.map((userId) => ({
          userId,
          actorUserId: subject.userId,
          organizationId: project.organizationId,
          projectId: project.id,
          type: 'access.requested',
          title: 'Access requested',
          data: { accessRequestId: requestId, resourceType: ref.type, resourceId: ref.id },
        })),
      });
    });
  }

  /** Pending requests on resources the actor manages. */
  async list(projectId: string, map: ProjectPermissionMap): Promise<{ requests: AccessRequestView[] }> {
    const skel = await this.resolver.skeleton(projectId);
    const rows = await this.prisma.accessRequest.findMany({
      where: { projectId, status: AccessRequestStatus.pending },
      include: {
        requester: { select: { name: true, email: true } },
        requestedRole: { select: { key: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const managed = rows.filter((r) =>
      atomsAt(map, skel, { type: r.resourceType, id: r.resourceId }).has('sharing:manage'),
    );
    const names = await this.names(projectId, managed);
    return {
      requests: managed.map((r) => ({
        id: r.id,
        requesterLabel: r.requester.name || r.requester.email,
        requesterEmail: r.requester.email,
        resourceType: r.resourceType,
        resourceId: r.resourceId,
        resourceName: names.get(`${r.resourceType}:${r.resourceId}`) ?? '',
        requestedRoleKey: r.requestedRole?.key ?? null,
        message: r.message,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /**
   * An ordinary grant write, so R4 applies: an approver cannot grant more than they hold.
   * The two toggles are never set by approval (§7.13) — that is always a separate act.
   */
  async approve(subject: UserSubject, requestId: string, roleKey: string): Promise<void> {
    const request = await this.pending(subject, requestId);
    const role = await grantableRole(this.prisma, request.project.organizationId, roleKey);
    const ref = { type: request.resourceType, id: request.resourceId };

    await this.writer.write(subject, request.projectId, async ({ tx, map, skel }) => {
      assertVisible(map, skel, ref);
      const proposed = materialise({ atoms: role.atoms, canUseAi: false, canViewRestricted: false });
      this.resolver.assertMayGrant(map, skel, ref, proposed);
      const current = await this.stillPending(tx, requestId);
      await assertNotGuestManager(tx, request.project.organizationId, { type: 'user', id: current.requesterId }, proposed);
      const member = await tx.orgMember.findUnique({
        where: { organizationId_userId: { organizationId: request.project.organizationId, userId: current.requesterId } },
        select: { id: true },
      });
      if (member === null) throw new ConflictException({ code: 'requester_not_member' });

      const key = { resourceType: ref.type, resourceId: ref.id, principalType: PrincipalType.user, principalId: current.requesterId };
      const grant = await tx.accessGrant.upsert({
        where: { resourceType_resourceId_principalType_principalId: key },
        update: { roleId: role.id },
        create: {
          ...key,
          roleId: role.id,
          organizationId: request.project.organizationId,
          projectId: request.projectId,
          createdById: subject.userId,
        },
      });
      await tx.accessRequest.update({
        where: { id: requestId },
        data: { status: AccessRequestStatus.approved, decidedById: subject.userId, decidedAt: new Date() },
      });
      await this.decided(tx, subject, request, 'access_request.approved', { grantId: grant.id, roleKey });
    });
  }

  /** Denial writes no grant, so it takes the lock without bumping the generation. */
  async deny(subject: UserSubject, requestId: string, decisionNote: string | null): Promise<void> {
    const request = await this.pending(subject, requestId);
    const ref = { type: request.resourceType, id: request.resourceId };

    await this.writer.write(
      subject,
      request.projectId,
      async ({ tx, map, skel }) => {
        assertVisible(map, skel, ref);
        this.resolver.assertMayDeleteGrant(map, skel, ref); // "holds sharing:manage here"
        await this.stillPending(tx, requestId);
        await tx.accessRequest.update({
          where: { id: requestId },
          data: {
            status: AccessRequestStatus.denied,
            decidedById: subject.userId,
            decidedAt: new Date(),
            denyReason: decisionNote,
          },
        });
        await this.decided(tx, subject, request, 'access_request.denied', { decisionNote });
      },
      { bump: false },
    );
  }

  // -------------------------------------------------------------------------------------

  /**
   * §7.13 routing: everyone holding `sharing:manage` at the resource (R5 already folds in
   * ancestors), else the org's owners and admins.
   *
   * ponytail: capped at 25 in resolver order, not "most recent activity in this project" —
   * there is no activity feed to order by yet. Revisit when one exists.
   */
  private async approvers(
    projectId: string,
    organizationId: string,
    ref: ResourceRef,
    requesterId: string,
  ): Promise<string[]> {
    const byPrincipal = await this.resolver.resolveResource(projectId, ref);
    let users = [...byPrincipal]
      .filter(([, atoms]) => atoms.has('sharing:manage'))
      .map(([key]) => splitPrincipalKey(key))
      .filter((p) => p.kind === 'user')
      .map((p) => p.id);
    if (users.length === 0) {
      const admins = await this.prisma.orgMember.findMany({
        where: { organizationId, role: { in: ['owner', 'admin'] } },
        select: { userId: true },
      });
      users = admins.map((a) => a.userId);
    }
    return users.filter((id) => id !== requesterId).slice(0, MAX_RECIPIENTS);
  }

  private async decided(
    tx: Tx,
    subject: UserSubject,
    request: { id: string; projectId: string; requesterId: string; resourceType: string; resourceId: string; project: { organizationId: string } },
    action: string,
    metadata: Record<string, string | null>,
  ): Promise<void> {
    await this.writer.audit(tx, subject, request.projectId, request.project.organizationId, {
      action,
      resourceType: request.resourceType,
      resourceId: request.resourceId,
      metadata: { accessRequestId: request.id, ...metadata },
    });
    await tx.notification.create({
      data: {
        userId: request.requesterId,
        actorUserId: subject.userId,
        organizationId: request.project.organizationId,
        projectId: request.projectId,
        type: 'access.decided',
        title: action === 'access_request.approved' ? 'Access granted' : 'Access request declined',
        body: metadata.decisionNote ?? null,
        data: { accessRequestId: request.id, resourceType: request.resourceType, resourceId: request.resourceId },
      },
    });
  }

  /** "Not yours", "not there" and "already decided" share one 404. */
  private async pending(subject: UserSubject, requestId: string) {
    const request = await this.prisma.accessRequest.findUnique({
      where: { id: requestId },
      include: { project: { select: { organizationId: true } } },
    });
    if (request?.status !== AccessRequestStatus.pending || request.project.organizationId !== subject.orgId) {
      throw new NotFoundException({ code: 'not_found', resourceType: 'access_request', id: requestId });
    }
    return request;
  }

  /** Re-read under the lock: two managers clicking Approve at once must not both win. */
  private async stillPending(tx: Tx, requestId: string): Promise<{ requesterId: string }> {
    const row = await tx.accessRequest.findUnique({
      where: { id: requestId },
      select: { status: true, requesterId: true },
    });
    if (row?.status !== AccessRequestStatus.pending) {
      throw new NotFoundException({ code: 'not_found', resourceType: 'access_request', id: requestId });
    }
    return row;
  }

  private async exists(projectId: string, ref: ResourceRef): Promise<boolean> {
    if (ref.type === 'project') return ref.id === projectId;
    const where = { id: ref.id, projectId };
    const row = ref.type === 'area'
      ? await this.prisma.area.findFirst({ where, select: { id: true } })
      : await this.prisma.entity.findFirst({ where, select: { id: true } });
    return row !== null;
  }

  private async names(
    projectId: string,
    rows: readonly { resourceType: string; resourceId: string }[],
  ): Promise<Map<string, string>> {
    const ids = (type: string) => rows.filter((r) => r.resourceType === type).map((r) => r.resourceId);
    const [project, areas, entities] = await Promise.all([
      this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } }),
      this.prisma.area.findMany({ where: { projectId, id: { in: ids('area') } }, select: { id: true, name: true } }),
      this.prisma.entity.findMany({ where: { projectId, id: { in: ids('entity') } }, select: { id: true, name: true } }),
    ]);
    return new Map([
      [`project:${projectId}`, project.name],
      ...areas.map((a) => [`area:${a.id}`, a.name] as const),
      ...entities.map((e) => [`entity:${e.id}`, e.name] as const),
    ]);
  }
}
