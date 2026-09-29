import { createHash, randomBytes } from 'node:crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BUILTIN_ROLE_IDS } from '@schemaloom/contracts';
import {
  PermissionResolver,
  atomsAt,
  materialise,
  type ProjectPermissionMap,
  type ResourceRef,
  type Subject,
} from '../access';
import { hashPassword } from '../auth/password';
import type { AppEnv } from '../config/env';
import { PrincipalType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { AccessWriter, assertVisible, builtInRole } from './access-write';
import type { CreateShareLinkDto } from './sharing.dto';

type UserSubject = Subject & { kind: 'user' };

export interface ShareLinkView {
  id: string;
  resourceType: ResourceRef['type'];
  resourceId: string;
  resourceName: string;
  createdAt: string;
  expiresAt: string | null;
  hasPassword: boolean;
  useCount: number;
  lastUsedAt: string | null;
}

/** sha256 of the URL token — the only form in which a token is ever stored (§7.12). */
export const hashShareToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/**
 * Doc 05 §7.12, R25 — a share link is an ordinary grant whose principal is the link.
 * The link row holds token + policy; the grant holds the target. Create and revoke touch
 * both, together, in one locked transaction.
 */
@Injectable()
export class ShareLinksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    private readonly writer: AccessWriter,
    private readonly config: ConfigService<AppEnv, true>,
  ) {}

  /** Live links on resources the actor manages. The token is never listed — it is not stored. */
  async list(projectId: string, map: ProjectPermissionMap): Promise<{ links: ShareLinkView[] }> {
    const skel = await this.resolver.skeleton(projectId);
    const rows = await this.prisma.shareLink.findMany({
      where: { projectId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    const grants = await this.prisma.accessGrant.findMany({
      where: {
        projectId,
        principalType: PrincipalType.share_link,
        principalId: { in: rows.map((r) => r.id) },
      },
      select: { principalId: true, resourceType: true, resourceId: true },
    });
    const target = new Map(
      grants.map((g) => [g.principalId, { type: g.resourceType, id: g.resourceId }]),
    );
    const names = await this.names(projectId);

    const links: ShareLinkView[] = [];
    for (const row of rows) {
      const ref = target.get(row.id);
      if (ref === undefined || !atomsAt(map, skel, ref).has('sharing:manage')) continue;
      links.push(this.view(row, ref, names.get(`${ref.type}:${ref.id}`) ?? ''));
    }
    return { links };
  }

  async create(
    subject: UserSubject,
    projectId: string,
    body: CreateShareLinkDto,
  ): Promise<{ link: ShareLinkView; url: string }> {
    const ref = { type: body.resourceType, id: body.resourceId };
    const viewer = await builtInRole(this.prisma, 'viewer');
    const token = randomBytes(32).toString('base64url');
    const passwordHash = body.password === null ? null : await hashPassword(body.password);
    const expiresAt = body.expiresAt === null ? null : new Date(body.expiresAt);

    const link = await this.writer.write(subject, projectId, async ({ tx, map, skel }) => {
      assertVisible(map, skel, ref);
      // §7.12: the role is ALWAYS the built-in viewer, so R4 is checked against exactly
      // that — and R17's `schema:view` ceiling is defence in depth, not the only control.
      this.resolver.assertMayGrant(
        map,
        skel,
        ref,
        materialise({ atoms: viewer.atoms, canUseAi: false, canViewRestricted: false }),
      );
      const project = await tx.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { organizationId: true },
      });

      const row = await tx.shareLink.create({
        data: {
          projectId,
          tokenHash: hashShareToken(token),
          passwordHash,
          expiresAt,
          createdById: subject.userId,
        },
      });
      await tx.accessGrant.create({
        data: {
          organizationId: project.organizationId,
          projectId,
          resourceType: ref.type,
          resourceId: ref.id,
          principalType: PrincipalType.share_link,
          principalId: row.id,
          roleId: BUILTIN_ROLE_IDS.viewer,
          createdById: subject.userId,
        },
      });
      await this.writer.audit(tx, subject, projectId, project.organizationId, {
        action: 'share_link.created',
        resourceType: ref.type,
        resourceId: ref.id,
        metadata: {
          shareLinkId: row.id,
          hasPassword: passwordHash !== null,
          expiresAt: body.expiresAt,
        },
      });
      return row;
    });

    const names = await this.names(projectId);
    const web = this.config.get('WEB_PUBLIC_URL', { infer: true }).replace(/\/$/, '');
    return {
      link: this.view(link, ref, names.get(`${ref.type}:${ref.id}`) ?? ''),
      // Returned exactly once. Only `sha256(token)` is stored.
      url: `${web}/s/${token}`,
    };
  }

  /** R25: revocation sets `revokedAt` AND deletes the grant, in one transaction. */
  async revoke(subject: UserSubject, linkId: string): Promise<void> {
    const link = await this.prisma.shareLink.findUnique({
      where: { id: linkId },
      include: { project: { select: { organizationId: true } } },
    });
    if (link?.project.organizationId !== subject.orgId || link.revokedAt !== null) {
      throw new NotFoundException({ code: 'not_found', resourceType: 'share_link', id: linkId });
    }
    const grant = await this.prisma.accessGrant.findFirst({
      where: { principalType: PrincipalType.share_link, principalId: linkId },
    });

    await this.writer.write(subject, link.projectId, async ({ tx, map, skel }) => {
      // A link whose grant is already gone (a pre-R25 row) is revoked at the project.
      const ref: ResourceRef =
        grant === null
          ? { type: 'project', id: link.projectId }
          : { type: grant.resourceType, id: grant.resourceId };
      assertVisible(map, skel, ref);
      this.resolver.assertMayDeleteGrant(map, skel, ref);
      await tx.shareLink.update({ where: { id: linkId }, data: { revokedAt: new Date() } });
      await tx.accessGrant.deleteMany({
        where: { principalType: PrincipalType.share_link, principalId: linkId },
      });
      await this.writer.audit(tx, subject, link.projectId, link.project.organizationId, {
        action: 'share_link.revoked',
        resourceType: ref.type,
        resourceId: ref.id,
        metadata: { shareLinkId: linkId },
      });
    });
  }

  private view(
    row: {
      id: string;
      createdAt: Date;
      expiresAt: Date | null;
      passwordHash: string | null;
      accessCount: number;
      lastAccessedAt: Date | null;
    },
    ref: ResourceRef,
    resourceName: string,
  ): ShareLinkView {
    return {
      id: row.id,
      resourceType: ref.type,
      resourceId: ref.id,
      resourceName,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
      hasPassword: row.passwordHash !== null,
      useCount: row.accessCount,
      lastUsedAt: row.lastAccessedAt?.toISOString() ?? null,
    };
  }

  private async names(projectId: string): Promise<Map<string, string>> {
    const [project, areas, entities] = await Promise.all([
      this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } }),
      this.prisma.area.findMany({ where: { projectId }, select: { id: true, name: true } }),
      this.prisma.entity.findMany({ where: { projectId }, select: { id: true, name: true } }),
    ]);
    return new Map([
      [`project:${projectId}`, project.name],
      ...areas.map((a) => [`area:${a.id}`, a.name] as const),
      ...entities.map((e) => [`entity:${e.id}`, e.name] as const),
    ]);
  }
}
