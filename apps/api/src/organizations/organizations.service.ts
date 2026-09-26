import { Injectable } from '@nestjs/common';
import { PermissionResolver, type Subject } from '../access';
import { PrismaService } from '../prisma/prisma.service';
import { toSummary, type ProjectSummary } from '../projects';
import type { OrganizationSummary } from './organizations.types';

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
      where: { organizationId: member.organizationId, deletedAt: null },
      select: { id: true, name: true, engineId: true, updatedAt: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (rows.length === 0) return [];

    const subject: Subject = { kind: 'user', userId, orgId: member.organizationId };
    const maps = await this.resolver.resolveProjects(
      subject,
      rows.map((row) => row.id),
    );

    return rows.flatMap((row) => {
      const map = maps.get(row.id);
      if (map === undefined || !this.resolver.canOpenProject(map)) return [];
      return [toSummary(row, map)];
    });
  }
}
