import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BUILT_IN_ROLE_ORDER, type OrgRole } from '@schemaloom/contracts';
import {
  PermissionResolver,
  atomsAt,
  materialise,
  type ProjectPermissionMap,
  type ProjectSkeleton,
  type ResourceRef,
  type Subject,
} from '../access';
import { PrincipalType } from '../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { AccessWriter, assertNotGuestManager, assertVisible, builtInRole } from './access-write';
import type { CreateGrantDto, UpdateGrantDto } from './sharing.dto';

type UserSubject = Subject & { kind: 'user' };
type ResourceType = ResourceRef['type'];

/** The wire shapes of `apps/web/src/features/sharing/model.ts`, by name. */
interface PrincipalRef {
  kind: 'user' | 'group' | 'email_invite';
  id: string;
  label: string;
  orgRole?: OrgRole | null;
}
interface ResourceNode {
  type: ResourceType;
  id: string;
  name: string;
  parentId: string | null;
}
interface ContributingGrant {
  id: string;
  principal: PrincipalRef;
  resourceType: ResourceType;
  resourceId: string;
  resourceName: string;
  roleKey: string;
  roleName: string;
  atoms: string[];
  canUseAi: boolean;
  canViewRestricted: boolean;
  expiresAt: string | null;
}
interface AccessEntry {
  principal: PrincipalRef;
  orgRole: OrgRole | null;
  email: string | null;
  grants: ContributingGrant[];
}
export interface AccessList {
  canManage: boolean;
  resources: ResourceNode[];
  roles: { key: string; name: string; atoms: string[]; builtIn: boolean }[];
  entries: AccessEntry[];
}

const CANDIDATE_LIMIT = 10;

/**
 * Doc 05 §7.7 ("Who has access"), §7.14 (the grant write path) and R4/R4a.
 *
 * The one visibility rule every read here follows: an actor sees the grants on exactly
 * the resources where they hold `sharing:manage`, which R5 already unions downward. An
 * Area manager therefore sees Billing's grants and never Catalog's — the dialog is not a
 * side door into the resource tree.
 */
@Injectable()
export class GrantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: PermissionResolver,
    private readonly writer: AccessWriter,
  ) {}

  async accessList(projectId: string, map: ProjectPermissionMap): Promise<AccessList> {
    // §7.7: 403 for guests. A guest's access is entirely grant-derived and deliberately
    // narrow; the member directory the dialog is built on is exactly what it withholds.
    if (map.orgRole === 'guest') throw new ForbiddenException({ code: 'sharing_not_permitted' });

    const skel = await this.resolver.skeleton(projectId);
    const [project, areas, entities, roles] = await Promise.all([
      this.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { name: true } }),
      this.prisma.area.findMany({
        where: { projectId },
        select: { id: true, name: true },
        orderBy: { position: 'asc' },
      }),
      this.prisma.entity.findMany({
        where: { projectId },
        select: { id: true, name: true, areaId: true },
        orderBy: { name: 'asc' },
      }),
      this.builtInRoles(),
    ]);

    const sees = (ref: ResourceRef): boolean => atomsAt(map, skel, ref).has('schema:view');
    const manages = (ref: ResourceRef): boolean =>
      atomsAt(map, skel, ref).has('sharing:manage');

    // The project node is always present: its name is already disclosed by the project
    // shell (§7.9), and the dialog has no tree to render without a root.
    const resources: ResourceNode[] = [
      { type: 'project', id: projectId, name: project.name, parentId: null },
    ];
    const visibleAreas = new Set<string>();
    for (const a of areas) {
      if (!sees({ type: 'area', id: a.id })) continue;
      visibleAreas.add(a.id);
      resources.push({ type: 'area', id: a.id, name: a.name, parentId: projectId });
    }
    for (const e of entities) {
      if (!sees({ type: 'entity', id: e.id })) continue;
      const parentId = e.areaId !== null && visibleAreas.has(e.areaId) ? e.areaId : projectId;
      resources.push({ type: 'entity', id: e.id, name: e.name, parentId });
    }

    const managed = resources.filter((r) => manages(r));
    if (managed.length === 0) return { canManage: false, resources, roles, entries: [] };

    return {
      canManage: true,
      resources,
      roles,
      entries: await this.entries(projectId, managed),
    };
  }

  /** One combobox for users and groups of the project's org (§7.7). Managers only. */
  async candidates(
    projectId: string,
    map: ProjectPermissionMap,
    query: string,
  ): Promise<{ principals: PrincipalRef[] }> {
    const skel = await this.resolver.skeleton(projectId);
    if (map.orgRole === 'guest' || !this.managesAnything(map, skel)) {
      throw new ForbiddenException({ code: 'sharing_not_permitted' });
    }
    const q = query.trim();
    if (q.length < 2) return { principals: [] };

    const { organizationId } = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { organizationId: true },
    });
    const contains = { contains: q, mode: 'insensitive' as const };
    const [members, groups] = await Promise.all([
      this.prisma.orgMember.findMany({
        where: { organizationId, user: { OR: [{ name: contains }, { email: contains }] } },
        select: { role: true, user: { select: { id: true, name: true, email: true } } },
        take: CANDIDATE_LIMIT,
      }),
      this.prisma.userGroup.findMany({
        where: { organizationId, name: contains },
        select: { id: true, name: true },
        take: CANDIDATE_LIMIT,
      }),
    ]);
    return {
      principals: [
        ...members.map((m) => ({
          kind: 'user' as const,
          id: m.user.id,
          label: m.user.name || m.user.email,
          orgRole: m.role,
        })),
        ...groups.map((g) => ({ kind: 'group' as const, id: g.id, label: g.name })),
      ],
    };
  }

  /**
   * `POST /projects/:id/grants`. R10 makes (resource, principal) unique, so a second POST
   * for the same pair UPDATES the grant rather than 409ing — the dialog cannot always
   * know whether a direct grant already exists at the scope it is showing.
   */
  async create(subject: UserSubject, projectId: string, body: CreateGrantDto): Promise<{ id: string }> {
    if (body.principalKind === 'email_invite') {
      // R11 is Phase 3: a pending grant needs the Invitation row, the email and the
      // acceptance transaction. Refused by name so the UI can say so.
      throw new BadRequestException({ code: 'email_invite_not_available' });
    }
    const { organizationId } = await this.projectOrg(projectId);
    await this.assertPrincipalInOrg(body.principalKind, body.principalId, organizationId);
    const role = await builtInRole(this.prisma, body.roleKey);
    const ref = { type: body.resourceType, id: body.resourceId };
    const principalType = PrincipalType[body.principalKind];

    return this.writer.write(subject, projectId, async ({ tx, map, skel }) => {
      assertVisible(map, skel, ref);
      const proposed = materialise({ atoms: role.atoms, canUseAi: body.canUseAi, canViewRestricted: body.canViewRestricted });
      this.resolver.assertMayGrant(map, skel, ref, proposed);
      await assertNotGuestManager(tx, organizationId, { type: principalType, id: body.principalId }, proposed);

      const key = {
        resourceType: ref.type,
        resourceId: ref.id,
        principalType,
        principalId: body.principalId,
      };
      const before = await tx.accessGrant.findUnique({
        where: { resourceType_resourceId_principalType_principalId: key },
      });
      const modifiers = {
        roleId: role.id,
        canUseAi: body.canUseAi,
        canViewRestricted: body.canViewRestricted,
      };
      const after = await tx.accessGrant.upsert({
        where: { resourceType_resourceId_principalType_principalId: key },
        update: modifiers,
        create: { ...key, ...modifiers, organizationId, projectId, createdById: subject.userId },
      });
      await this.writer.audit(tx, subject, projectId, organizationId, {
        action: before === null ? 'grant.created' : 'grant.updated',
        resourceType: ref.type,
        resourceId: ref.id,
        metadata: { grantId: after.id, before: snapshot(before), after: snapshot(after) },
      });
      return { id: after.id };
    });
  }

  /** `PATCH /grants/:id` — role and the two toggles; R4 measured at the grant's resource. */
  async update(subject: UserSubject, grantId: string, body: UpdateGrantDto): Promise<{ id: string }> {
    const grant = await this.editableGrant(subject, grantId);
    const role = await builtInRole(this.prisma, body.roleKey);
    const ref = refOf(grant);

    return this.writer.write(subject, grant.projectId, async ({ tx, map, skel }) => {
      assertVisible(map, skel, ref);
      const proposed = materialise({ atoms: role.atoms, canUseAi: body.canUseAi, canViewRestricted: body.canViewRestricted });
      this.resolver.assertMayGrant(map, skel, ref, proposed);
      await assertNotGuestManager(tx, grant.organizationId, { type: grant.principalType, id: grant.principalId }, proposed);
      const before = await tx.accessGrant.findUnique({ where: { id: grantId } });
      if (before === null) throw new NotFoundException({ code: 'not_found', resourceType: 'grant', id: grantId });
      const after = await tx.accessGrant.update({
        where: { id: grantId },
        data: { roleId: role.id, canUseAi: body.canUseAi, canViewRestricted: body.canViewRestricted },
      });
      await this.writer.audit(tx, subject, grant.projectId, grant.organizationId, {
        action: 'grant.updated',
        resourceType: ref.type,
        resourceId: ref.id,
        metadata: { grantId, before: snapshot(before), after: snapshot(after) },
      });
      return { id: grantId };
    });
  }

  /** `DELETE /grants/:id` — R4a: subject to R5 only, never to R4. */
  async remove(subject: UserSubject, grantId: string): Promise<void> {
    const grant = await this.editableGrant(subject, grantId);
    const ref = refOf(grant);

    await this.writer.write(subject, grant.projectId, async ({ tx, map, skel }) => {
      assertVisible(map, skel, ref);
      this.resolver.assertMayDeleteGrant(map, skel, ref);
      const before = await tx.accessGrant.findUnique({ where: { id: grantId } });
      if (before === null) throw new NotFoundException({ code: 'not_found', resourceType: 'grant', id: grantId });
      await tx.accessGrant.delete({ where: { id: grantId } });
      await this.writer.audit(tx, subject, grant.projectId, grant.organizationId, {
        action: 'grant.deleted',
        resourceType: ref.type,
        resourceId: ref.id,
        metadata: { grantId, before: snapshot(before) },
      });
    });
  }

  // -------------------------------------------------------------------------------------

  private async entries(projectId: string, managed: readonly ResourceNode[]): Promise<AccessEntry[]> {
    const names = new Map(managed.map((r) => [`${r.type}:${r.id}`, r.name]));
    const grants = (
      await this.prisma.accessGrant.findMany({
        where: {
          projectId,
          principalType: { in: [PrincipalType.user, PrincipalType.group] },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        include: { role: { select: { key: true, name: true, atoms: true } } },
        orderBy: { createdAt: 'asc' },
      })
    ).filter((g) => names.has(`${g.resourceType}:${g.resourceId}`));

    const { organizationId } = await this.projectOrg(projectId);
    const groupIds = [...new Set(grants.filter((g) => g.principalType === 'group').map((g) => g.principalId))];
    const [groups, memberships] = await Promise.all([
      this.prisma.userGroup.findMany({
        where: { id: { in: groupIds }, organizationId },
        select: { id: true, name: true },
      }),
      this.prisma.groupMember.findMany({
        where: { groupId: { in: groupIds } },
        select: { groupId: true, userId: true },
      }),
    ]);
    const userIds = [
      ...new Set([
        ...grants.filter((g) => g.principalType === 'user').map((g) => g.principalId),
        ...memberships.map((m) => m.userId),
      ]),
    ];
    const members = await this.prisma.orgMember.findMany({
      where: { organizationId, userId: { in: userIds } },
      select: { role: true, user: { select: { id: true, name: true, email: true } } },
    });

    const groupRef = new Map(
      groups.map((g) => [g.id, { kind: 'group' as const, id: g.id, label: g.name }]),
    );
    const userRef = new Map(
      members.map((m) => [
        m.user.id,
        {
          principal: { kind: 'user' as const, id: m.user.id, label: m.user.name || m.user.email, orgRole: m.role },
          orgRole: m.role,
          email: m.user.email,
        },
      ]),
    );

    const wire = (g: (typeof grants)[number], principal: PrincipalRef): ContributingGrant => ({
      id: g.id,
      principal,
      resourceType: g.resourceType,
      resourceId: g.resourceId,
      resourceName: names.get(`${g.resourceType}:${g.resourceId}`) ?? '',
      roleKey: g.role.key,
      roleName: g.role.name,
      atoms: g.role.atoms,
      canUseAi: g.canUseAi,
      canViewRestricted: g.canViewRestricted,
      expiresAt: g.expiresAt?.toISOString() ?? null,
    });

    // One entry per PRINCIPAL. A user's entry also carries the grants they hold via a
    // group, tagged with the group principal: E3 means a narrowing grant narrows only its
    // own principal, and the client's R15 preview needs both to say so.
    const entries = new Map<string, AccessEntry>();
    const userEntry = (userId: string): AccessEntry | undefined => {
      const ref = userRef.get(userId);
      if (ref === undefined) return undefined; // offboarded: R12.2 already ignores the grant
      const key = `user:${userId}`;
      const existing: AccessEntry = entries.get(key) ?? { ...ref, grants: [] };
      entries.set(key, existing);
      return existing;
    };

    for (const g of grants) {
      if (g.principalType === 'user') {
        const entry = userEntry(g.principalId);
        entry?.grants.push(wire(g, entry.principal));
        continue;
      }
      const group = groupRef.get(g.principalId);
      if (group === undefined) continue;
      const key = `group:${group.id}`;
      const entry: AccessEntry = entries.get(key) ?? { principal: group, orgRole: null, email: null, grants: [] };
      entry.grants.push(wire(g, group));
      entries.set(key, entry);
      for (const m of memberships) {
        if (m.groupId === group.id) userEntry(m.userId)?.grants.push(wire(g, group));
      }
    }
    return [...entries.values()];
  }

  private async builtInRoles(): Promise<AccessList['roles']> {
    const rows = await this.prisma.role.findMany({
      where: { organizationId: null, isBuiltIn: true, isArchived: false },
      select: { key: true, name: true, atoms: true },
    });
    const order = BUILT_IN_ROLE_ORDER as readonly string[];
    return rows
      .filter((r) => order.includes(r.key))
      .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
      .map((r) => ({ ...r, builtIn: true }));
  }

  private managesAnything(map: ProjectPermissionMap, skel: ProjectSkeleton): boolean {
    if (map.projectAtoms.has('sharing:manage')) return true;
    for (const atoms of map.areaAtoms.values()) if (atoms.has('sharing:manage')) return true;
    return skel.entities.some((e) => atomsAt(map, skel, { type: 'entity', id: e.id }).has('sharing:manage'));
  }

  private async projectOrg(projectId: string): Promise<{ organizationId: string }> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { organizationId: true },
    });
    if (project === null) throw new NotFoundException({ code: 'not_found', resourceType: 'project', id: projectId });
    return project;
  }

  /** A grant to someone outside the org is inert (R12.2) and would render as a ghost. */
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
        : await this.prisma.userGroup.findFirst({ where: { id, organizationId }, select: { id: true } });
    if (found === null) throw new NotFoundException({ code: 'not_found', resourceType: kind, id });
  }

  /**
   * The grant behind `/grants/:id`, or the same 404 for "not yours" and "not there".
   * Share-link grants are revoked through `DELETE /share-links/:id` only (R25): deleting
   * the grant alone leaves a token that unlocks into a project where everything 404s.
   */
  private async editableGrant(subject: UserSubject, grantId: string) {
    const grant = await this.prisma.accessGrant.findUnique({ where: { id: grantId } });
    if (grant?.organizationId !== subject.orgId) {
      throw new NotFoundException({ code: 'not_found', resourceType: 'grant', id: grantId });
    }
    if (grant.principalType === 'share_link') {
      throw new ConflictException({ code: 'revoke_via_share_link' });
    }
    return grant;
  }
}

function refOf(grant: { resourceType: ResourceType; resourceId: string }): ResourceRef {
  return { type: grant.resourceType, id: grant.resourceId };
}

/** The audit before/after image: the policy columns only, never timestamps. */
function snapshot(
  grant: {
    principalType: string;
    principalId: string;
    roleId: string;
    canUseAi: boolean;
    canViewRestricted: boolean;
    expiresAt: Date | null;
  } | null,
) {
  if (grant === null) return null;
  return {
    principalType: grant.principalType,
    principalId: grant.principalId,
    roleId: grant.roleId,
    canUseAi: grant.canUseAi,
    canViewRestricted: grant.canViewRestricted,
    expiresAt: grant.expiresAt?.toISOString() ?? null,
  };
}
