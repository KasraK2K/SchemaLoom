import { randomBytes } from 'node:crypto';
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PermissionResolver, hasCompleteView, type Subject } from '../access';
import { PrismaService } from '../prisma/prisma.service';
import { toSummary, type ProjectSummary } from '../projects';
import type { OrganizationSummary, WorkspaceSummary } from './organizations.types';

/** PostgreSQL 23505 on the partial `lower(slug)` index, surfaced by Prisma as P2002. */
const UNIQUE_VIOLATION = 'P2002';

/** `Acme Corp!` → `acme-corp`. Empty for a name with no latin letters or digits. */
export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
  ) {}

  /**
   * Every organisation the user is an `OrgMember` of. **A user who belongs to nowhere
   * gets `[]`, never a 404.** The window between registering and joining a first org is a
   * real state, not an error, and the UI's create-an-org prompt is what fills it — an
   * error status there would render as "something went wrong" on a perfectly healthy
   * account.
   *
   * Soft-deleted orgs are filtered here rather than left to the caller: `readProjectRows`
   * already drops their projects (step 0), so an org that survived this list would render
   * as a permanently empty one.
   */
  async listForUser(userId: string): Promise<OrganizationSummary[]> {
    const rows = await this.prisma.orgMember.findMany({
      where: { userId, organization: { deletedAt: null } },
      select: {
        role: true,
        organization: { select: { id: true, slug: true, name: true } },
      },
      orderBy: { organization: { name: 'asc' } },
    });
    return rows.map((row) => ({
      id: row.organization.id,
      slug: row.organization.slug,
      name: row.organization.name,
      orgRole: row.role,
    }));
  }

  /**
   * A new org with the caller as its `owner`, in one transaction — an org with no owner
   * is unreachable by anyone.
   *
   * The slug is derived, not asked for. On a clash (or a name with nothing slug-able in
   * it) a random suffix is appended and the insert retried; the unique index is the
   * arbiter, so two concurrent creates of "Acme" cannot both win the bare slug.
   */
  async create(userId: string, name: string): Promise<OrganizationSummary> {
    const base = slugify(name) || 'org';
    for (let attempt = 0; ; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
      try {
        const org = await this.prisma.organization.create({
          data: { name, slug, members: { create: { userId, role: 'owner' } } },
          select: { id: true, slug: true, name: true },
        });
        return { ...org, orgRole: 'owner' };
      } catch (error) {
        if ((error as { code?: unknown }).code !== UNIQUE_VIOLATION || attempt >= 3) throw error;
      }
    }
  }

  /**
   * The projects in one org that the caller may actually OPEN.
   *
   * Two rules, and both are the point of the method:
   *
   * 1. **Membership is checked before the org is named.** A non-member gets `[]` — the
   *    same answer as an org slug that does not exist. A 403 or a 404 that fires only for
   *    real orgs turns this route into an existence oracle for every organisation on the
   *    deployment, which is the same leak §10.3's "invisible is 404" rule exists to shut.
   *
   * 2. **One batch resolve, never one per project.** `resolveProjects` takes every
   *    candidate id at once: the project rows and all three generation counters come back
   *    in a SINGLE round trip and the org-membership lookup is shared (§10.4). An org
   *    with 200 projects costs one resolve call, not 200. `canOpenProject` then reads off
   *    each map with no skeleton (§7.9), which is what keeps the sidebar cheap.
   *
   * The `Subject` is built from the membership row THIS method verified, not from the
   * session's active org. The resolver measures org role against each project's own
   * organisation, so that is both correct and what lets a user in three orgs list all
   * three without re-issuing a session per switch.
   */
  async listProjects(userId: string, orgSlug: string): Promise<ProjectSummary[]> {
    const member = await this.prisma.orgMember.findFirst({
      where: { userId, organization: { slug: orgSlug, deletedAt: null } },
      select: { organizationId: true },
    });
    if (!member) return [];

    const rows = await this.prisma.project.findMany({
      // Phase 10: a change request's draft is opened from its request, never listed.
      where: { organizationId: member.organizationId, deletedAt: null, draftOfId: null },
      select: {
        id: true,
        name: true,
        engineId: true,
        engineVersion: true,
        updatedAt: true,
        requireChangeRequests: true,
        connection: { select: { lastCheckStatus: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (rows.length === 0) return [];

    const subject: Subject = { kind: 'user', userId, orgId: member.organizationId };
    const maps = await this.resolver.resolveProjects(
      subject,
      rows.map((row) => row.id),
    );
    const open = rows.flatMap((row) => {
      const map = maps.get(row.id);
      return map !== undefined && this.resolver.canOpenProject(map) ? [{ row, map }] : [];
    });

    // The list's columns need a complete view (ProjectSummary). Skeletons are cached per
    // project generation, so this is a cache read per listed project, not a resolve.
    const skeletons = await Promise.all(open.map(({ row }) => this.resolver.skeleton(row.id)));
    const complete = new Set(
      open.flatMap(({ row, map }, i) => {
        const skel = skeletons[i];
        return skel !== undefined && hasCompleteView(map, skel) ? [row.id] : [];
      }),
    );
    const requests =
      complete.size === 0
        ? []
        : await this.prisma.changeRequest.groupBy({
            by: ['projectId'],
            where: { projectId: { in: [...complete] }, status: 'open' },
            _count: { _all: true },
          });
    const openRequests = new Map(requests.map((r) => [r.projectId, r._count._all]));

    return open.map(({ row, map }, i) => {
      const full = complete.has(row.id);
      const status = row.connection?.lastCheckStatus;
      return toSummary(row, map, {
        tableCount: full ? (skeletons[i]?.entities.length ?? null) : null,
        openChangeRequests: full ? (openRequests.get(row.id) ?? 0) : null,
        driftStatus:
          full &&
          map.projectAtoms.has('schema:edit') &&
          (status === 'in_sync' || status === 'drift' || status === 'failed')
            ? status
            : null,
      });
    });
  }

  /**
   * Doc 05 §3.2: owner, admin and member may LIST workspaces; a guest's access comes only
   * from grants and workspaces are not grantable, so a guest (like a non-member) gets `[]`.
   */
  async listWorkspaces(userId: string, orgSlug: string): Promise<WorkspaceSummary[]> {
    const member = await this.membership(userId, orgSlug);
    if (member === null) return [];
    // Roadmap 19: a guest sees only the workspaces they (or a group of theirs) hold a live
    // grant on; everyone else sees them all, as before.
    const now = new Date();
    const guestScope =
      member.role === 'guest'
        ? {
            grants: {
              some: {
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                AND: {
                  OR: [
                    { principalType: 'user' as const, principalId: userId },
                    {
                      principalType: 'group' as const,
                      principalId: {
                        in: (
                          await this.prisma.groupMember.findMany({
                            where: { userId, group: { organizationId: member.organizationId } },
                            select: { groupId: true },
                          })
                        ).map((g) => g.groupId),
                      },
                    },
                  ],
                },
              },
            },
          }
        : {};
    return this.prisma.workspace.findMany({
      where: { organizationId: member.organizationId, ...guestScope },
      select: WORKSPACE,
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** §3.2: owner and admin only. A non-member gets the same 404 as a missing org. */
  async createWorkspace(userId: string, orgSlug: string, name: string): Promise<WorkspaceSummary> {
    const member = await this.membership(userId, orgSlug);
    if (member === null) throw new NotFoundException({ code: 'not_found' });
    if (member.role !== 'owner' && member.role !== 'admin') {
      throw new ForbiddenException({ code: 'forbidden' });
    }
    const organizationId = member.organizationId;
    const last = await this.prisma.workspace.findFirst({
      where: { organizationId },
      orderBy: { position: 'desc' },
      select: { position: true },
    });
    const base = slugify(name) || 'workspace';
    for (let attempt = 0; ; attempt++) {
      const slug = attempt === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
      try {
        return await this.prisma.workspace.create({
          data: { organizationId, name, slug, position: (last?.position ?? -1) + 1 },
          select: WORKSPACE,
        });
      } catch (error) {
        if ((error as { code?: unknown }).code !== UNIQUE_VIOLATION || attempt >= 3) throw error;
      }
    }
  }

  private membership(userId: string, orgSlug: string) {
    return this.prisma.orgMember.findFirst({
      where: { userId, organization: { slug: orgSlug, deletedAt: null } },
      select: { organizationId: true, role: true },
    });
  }
}

const WORKSPACE = { id: true, name: true, slug: true } as const;
