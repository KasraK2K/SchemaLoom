import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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
      await lockProject(tx, projectId);
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

/**
 * The project's sharing lock, held to the end of `tx`. Invitation acceptance takes it too:
 * it rewrites a grant without being a manager, so it cannot go through `write`.
 *
 * ponytail: one lock per project. Per-resource locks only if a project ever sees
 * contended sharing writes, which a schema designer will not.
 */
export async function lockProject(tx: Tx, projectId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${projectId}, 0))`;
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

/** A built-in role by key — share links, which always write `viewer` (§7.12). */
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

export interface GrantableRole {
  id: string;
  key: string;
  name: string;
  atoms: string[];
  organizationId: string | null;
  isArchived: boolean;
}

/**
 * The role a grant write may attach: a built-in, or a custom role of the grant's own org.
 * Every grant write path loads its role here, so R3 and archival are checked once.
 * Built-in and custom keys never collide — `RolesService` refuses a built-in key as a slug.
 */
export async function grantableRole(
  db: Tx | PrismaService,
  organizationId: string,
  key: string,
): Promise<GrantableRole> {
  const role = await db.role.findFirst({
    where: { key, OR: [{ organizationId: null, isBuiltIn: true }, { organizationId }] },
    select: { id: true, key: true, name: true, atoms: true, organizationId: true, isArchived: true },
  });
  if (role === null) throw new BadRequestException({ code: 'unknown_role', roleKey: key });
  assertRoleUsable(role, organizationId);
  return role;
}

/**
 * R3 (doc 05 §4.1) — a custom role is usable only inside its own org. The query above
 * already scopes to the org; this is what survives someone editing that query. Archived
 * roles are refused on write and keep working on existing grants (doc 02, `Role.isArchived`).
 */
export function assertRoleUsable(
  role: Pick<GrantableRole, 'key' | 'organizationId' | 'isArchived'>,
  organizationId: string,
): void {
  if (role.organizationId !== null && role.organizationId !== organizationId) {
    throw new ForbiddenException({ code: 'role_cross_org' });
  }
  if (role.isArchived) throw new BadRequestException({ code: 'role_archived', roleKey: role.key });
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
 * resolver pass. An `email_invite` principal becomes a guest on acceptance (R11), so it is
 * refused up front rather than converted into a Manager grant that silently is not one.
 */
export async function assertNotGuestManager(
  db: Tx | PrismaService,
  organizationId: string,
  principal: { type: string; id: string },
  atoms: AtomSet,
): Promise<void> {
  if (!atoms.has('sharing:manage')) return;
  if (principal.type === 'email_invite') throw new BadRequestException({ code: 'guest_cannot_manage' });
  if (principal.type !== 'user') return;
  const member = await db.orgMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: principal.id } },
    select: { role: true },
  });
  if (member?.role === 'guest') throw new BadRequestException({ code: 'guest_cannot_manage' });
}
