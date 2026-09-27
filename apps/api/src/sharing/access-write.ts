import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  PermissionResolver,
  atomsAt,
  type AtomSet,
  type ProjectPermissionMap,
  type ProjectSkeleton,
  type ResourceRef,
  type Subject,
} from '../access';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type Tx = Prisma.TransactionClient;

export interface WriteScope {
  readonly tx: Tx;
  /** The actor, re-resolved INSIDE the lock (R26) — never the guard's cached map. */
  readonly map: ProjectPermissionMap;
  readonly skel: ProjectSkeleton;
}

export interface AuditEntry {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly metadata?: Prisma.InputJsonValue;
}

/**
 * Doc 05 §7.14, R26 — every access-control write is: project advisory lock → re-resolve
 * the actor → check → write + audit + `permGeneration++` in ONE transaction → commit →
 * invalidate. The lock is what makes R4 a check against current authority rather than
 * against a map two requests old.
 */
@Injectable()
export class AccessWriter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
  ) {}

  async write<T>(
    subject: Subject & { kind: 'user' },
    projectId: string,
    fn: (scope: WriteScope) => Promise<T>,
    options: { bump: boolean } = { bump: true },
  ): Promise<T> {
    const result = await this.prisma.$transaction(async (tx) => {
      // ponytail: one lock per project. Per-resource locks only if a project ever sees
      // contended sharing writes, which a schema designer will not.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0))`;
      const map = await this.resolver.resolveProjectUncached(subject, projectId);
      const skel = await this.resolver.skeleton(projectId);
      const out = await fn({ tx, map, skel });
      if (options.bump) {
        await tx.project.update({
          where: { id: projectId },
          data: { permGeneration: { increment: 1 } },
        });
      }
      return out;
    });
    if (options.bump) await this.resolver.invalidate({ project: projectId });
    return result;
  }

  audit(
    tx: Tx,
    subject: Subject & { kind: 'user' },
    projectId: string,
    organizationId: string,
    entry: AuditEntry,
  ): Promise<unknown> {
    return tx.auditLog.create({
      data: {
        organizationId,
        projectId,
        actorUserId: subject.userId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        metadata: entry.metadata ?? {},
      },
    });
  }
}

/** §10.3 step 8 — a resource the actor cannot see is a 404, same body as a wrong id. */
export function assertVisible(
  map: ProjectPermissionMap,
  skel: ProjectSkeleton,
  ref: ResourceRef,
): void {
  if (!atomsAt(map, skel, ref).has('schema:view')) {
    throw new NotFoundException({ code: 'not_found', resourceType: ref.type, id: ref.id });
  }
}

/**
 * Phase 1 grants only the five built-ins (custom roles are Phase 3). Archived roles are
 * refused on write and keep working on existing grants (doc 05 §6.3).
 */
export async function builtInRole(
  db: Tx | PrismaService,
  key: string,
): Promise<{ id: string; key: string; name: string; atoms: string[] }> {
  const role = await db.role.findFirst({
    where: { key, organizationId: null, isBuiltIn: true, isArchived: false },
    select: { id: true, key: true, name: true, atoms: true },
  });
  if (role === null) throw new BadRequestException({ code: 'unknown_role', roleKey: key });
  return role;
}

/** The narrowing every handler needs: a share-link subject never reaches these routes. */
export function userSubject(subject: Subject | null): Subject & { kind: 'user' } {
  if (subject?.kind !== 'user') throw new NotFoundException({ code: 'not_found' });
  return subject;
}

/**
 * R9 — a guest can never hold `sharing:manage`. The resolver subtracts it anyway; this is
 * the write-time half, so the dialog never shows a Manager grant that silently is not one.
 * Only `user` principals have an org role; a group containing a guest is covered by the
 * resolver pass.
 */
export async function assertNotGuestManager(
  db: Tx | PrismaService,
  organizationId: string,
  principal: { type: string; id: string },
  atoms: AtomSet,
): Promise<void> {
  if (principal.type !== 'user' || !atoms.has('sharing:manage')) return;
  const member = await db.orgMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: principal.id } },
    select: { role: true },
  });
  if (member?.role === 'guest') throw new BadRequestException({ code: 'guest_cannot_manage' });
}
