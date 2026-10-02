import { randomBytes } from 'node:crypto';
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
import { hashInviteToken } from '../auth';
import { PrincipalType } from '../generated/prisma/enums';
import { MailService } from '../mail/mail.service';
import { NotificationsService, type CreatedNotification } from '../notifications';
import { PrismaService } from '../prisma/prisma.service';
import { AccessWriter, assertNotGuestManager, assertVisible, grantableRole } from './access-write';
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
const SHARED_NOUN: Record<ResourceType, string> = {
  project: 'a project',
  area: 'an area',
  entity: 'a table',
};
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The shape `access_grants_email_shape_ck` enforces, checked first so it is a 400. */
const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Lives with the sign-up policy, which checks invitation tokens too. */
export { hashInviteToken };

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
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
  ) {}

  async accessList(projectId: string, map: ProjectPermissionMap): Promise<AccessList> {
    // §7.7: 403 for guests. A guest's access is entirely grant-derived and deliberately
    // narrow; the member directory the dialog is built on is exactly what it withholds.
    if (map.orgRole === 'guest') throw new ForbiddenException({ code: 'sharing_not_permitted' });

    const skel = await this.resolver.skeleton(projectId);
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { name: true, organizationId: true },
    });
    const [areas, entities, roles] = await Promise.all([
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
      this.pickerRoles(project.organizationId),
    ]);

    const sees = (ref: ResourceRef): boolean => atomsAt(map, skel, ref).has('schema:view');
    const manages = (ref: ResourceRef): boolean => atomsAt(map, skel, ref).has('sharing:manage');

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
  async create(
    subject: UserSubject,
    projectId: string,
    body: CreateGrantDto,
  ): Promise<{ id: string }> {
    const { organizationId } = await this.projectOrg(projectId);
    if (body.principalKind === 'email_invite')
      return this.invite(subject, projectId, organizationId, body);
    await this.assertPrincipalInOrg(body.principalKind, body.principalId, organizationId);
    const role = await grantableRole(this.prisma, organizationId, body.roleKey);
    const ref = { type: body.resourceType, id: body.resourceId };
    const principalType = PrincipalType[body.principalKind];
    const url = await this.notifications.projectUrl(projectId);

    const result = await this.writer.write(subject, projectId, async ({ tx, map, skel }) => {
      assertVisible(map, skel, ref);
      const proposed = materialise({
        atoms: role.atoms,
        canUseAi: body.canUseAi,
        canViewRestricted: body.canViewRestricted,
      });
      this.resolver.assertMayGrant(map, skel, ref, proposed);
      await assertNotGuestManager(
        tx,
        organizationId,
        { type: principalType, id: body.principalId },
        proposed,
      );

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
      // Phase 4 §4 `resource.shared` — a NEW grant to a person, never to yourself. The title
      // names the kind of resource only (L7); the grant itself is what makes it visible.
      let sent: CreatedNotification[] = [];
      if (
        before === null &&
        principalType === PrincipalType.user &&
        body.principalId !== subject.userId
      ) {
        const actor = await tx.user.findUniqueOrThrow({
          where: { id: subject.userId },
          select: { name: true },
        });
        sent = await this.notifications.create(tx, [
          {
            userId: body.principalId,
            actorUserId: subject.userId,
            organizationId,
            projectId,
            type: 'resource.shared',
            title: `${actor.name} shared ${SHARED_NOUN[ref.type]} with you`,
            url,
            data: { grantId: after.id, resourceType: ref.type, resourceId: ref.id },
          },
        ]);
      }
      return { id: after.id, sent };
    });
    await this.notifications.deliver(result.sent);
    return { id: result.id };
  }

  /** `PATCH /grants/:id` — role and the two toggles; R4 measured at the grant's resource. */
  async update(
    subject: UserSubject,
    grantId: string,
    body: UpdateGrantDto,
  ): Promise<{ id: string }> {
    const grant = await this.editableGrant(subject, grantId);
    const role = await grantableRole(this.prisma, grant.organizationId, body.roleKey);
    const ref = refOf(grant);

    return this.writer.write(subject, grant.projectId, async ({ tx, map, skel }) => {
      assertVisible(map, skel, ref);
      const proposed = materialise({
        atoms: role.atoms,
        canUseAi: body.canUseAi,
        canViewRestricted: body.canViewRestricted,
      });
      this.resolver.assertMayGrant(map, skel, ref, proposed);
      await assertNotGuestManager(
        tx,
        grant.organizationId,
        { type: grant.principalType, id: grant.principalId },
        proposed,
      );
      const before = await tx.accessGrant.findUnique({ where: { id: grantId } });
      if (before === null)
        throw new NotFoundException({ code: 'not_found', resourceType: 'grant', id: grantId });
      const after = await tx.accessGrant.update({
        where: { id: grantId },
        data: {
          roleId: role.id,
          canUseAi: body.canUseAi,
          canViewRestricted: body.canViewRestricted,
        },
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

  /**
   * R11 — a pending `email_invite` grant plus its `Invitation`, through the same R4 checks
   * as any grant. An address that already belongs to an org member is not an invite at
   * all: it becomes that member's ordinary user grant. Anyone else joins as a `guest`.
   * A second invite to the same (resource, email) updates the grant and re-sends with a
   * fresh token — the old link stops working, which is what "resend" should mean.
   */
  private async invite(
    subject: UserSubject,
    projectId: string,
    organizationId: string,
    body: CreateGrantDto,
  ): Promise<{ id: string }> {
    const email = body.principalId.trim().toLowerCase();
    if (!EMAIL_SHAPE.test(email)) throw new BadRequestException({ code: 'invalid_email' });

    const member = await this.prisma.orgMember.findFirst({
      where: { organizationId, user: { email } },
      select: { userId: true },
    });
    if (member !== null) {
      const { resourceType, resourceId, roleKey, canUseAi, canViewRestricted } = body;
      return this.create(subject, projectId, {
        principalKind: 'user',
        principalId: member.userId,
        resourceType,
        resourceId,
        roleKey,
        canUseAi,
        canViewRestricted,
      });
    }

    const org = await this.prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { name: true, settings: true },
    });
    // orgSettings (doc 02 §7): `allowGuestInvites` defaults to true when unset.
    const settings = org.settings as { allowGuestInvites?: unknown } | null;
    if (settings?.allowGuestInvites === false) {
      throw new ForbiddenException({ code: 'guest_invites_disabled' });
    }

    const role = await grantableRole(this.prisma, organizationId, body.roleKey);
    const ref = { type: body.resourceType, id: body.resourceId };
    const token = randomBytes(32).toString('base64url');

    const result = await this.writer.write(subject, projectId, async ({ tx, map, skel }) => {
      assertVisible(map, skel, ref);
      const proposed = materialise({
        atoms: role.atoms,
        canUseAi: body.canUseAi,
        canViewRestricted: body.canViewRestricted,
      });
      this.resolver.assertMayGrant(map, skel, ref, proposed);
      await assertNotGuestManager(
        tx,
        organizationId,
        { type: PrincipalType.email_invite, id: email },
        proposed,
      );

      const key = {
        resourceType: ref.type,
        resourceId: ref.id,
        principalType: PrincipalType.email_invite,
        principalId: email,
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
      const invitation = {
        tokenHash: hashInviteToken(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        invitedById: subject.userId,
        revokedAt: null,
      };
      await tx.invitation.upsert({
        where: { accessGrantId: after.id },
        update: invitation,
        create: { ...invitation, organizationId, email, orgRole: 'guest', accessGrantId: after.id },
      });
      await this.writer.audit(tx, subject, projectId, organizationId, {
        action: before === null ? 'grant.created' : 'grant.updated',
        resourceType: ref.type,
        resourceId: ref.id,
        metadata: {
          grantId: after.id,
          invited: email,
          before: snapshot(before),
          after: snapshot(after),
        },
      });
      const inviter = await tx.user.findUniqueOrThrow({
        where: { id: subject.userId },
        select: { name: true, email: true },
      });
      return { id: after.id, inviterName: inviter.name || inviter.email };
    });

    await this.mail.sendInvitationEmail(email, result.inviterName, org.name, token);
    return { id: result.id };
  }

  /**
   * `DELETE /grants/:id` — R4a: subject to R5 only, never to R4. For a pending invite this
   * is also the revoke: `invitations.access_grant_id` cascades, so the token dies with it.
   */
  async remove(subject: UserSubject, grantId: string): Promise<void> {
    const grant = await this.editableGrant(subject, grantId);
    const ref = refOf(grant);

    await this.writer.write(subject, grant.projectId, async ({ tx, map, skel }) => {
      assertVisible(map, skel, ref);
      this.resolver.assertMayDeleteGrant(map, skel, ref);
      const before = await tx.accessGrant.findUnique({ where: { id: grantId } });
      if (before === null)
        throw new NotFoundException({ code: 'not_found', resourceType: 'grant', id: grantId });
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

  private async entries(
    projectId: string,
    managed: readonly ResourceNode[],
  ): Promise<AccessEntry[]> {
    const names = new Map(managed.map((r) => [`${r.type}:${r.id}`, r.name]));
    const grants = (
      await this.prisma.accessGrant.findMany({
        where: {
          projectId,
          principalType: {
            in: [PrincipalType.user, PrincipalType.group, PrincipalType.email_invite],
          },
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        include: { role: { select: { key: true, name: true, atoms: true } } },
        orderBy: { createdAt: 'asc' },
      })
    ).filter((g) => names.has(`${g.resourceType}:${g.resourceId}`));

    const { organizationId } = await this.projectOrg(projectId);
    const groupIds = [
      ...new Set(grants.filter((g) => g.principalType === 'group').map((g) => g.principalId)),
    ];
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
          principal: {
            kind: 'user' as const,
            id: m.user.id,
            label: m.user.name || m.user.email,
            orgRole: m.role,
          },
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
      if (g.principalType === 'email_invite') {
        // A pending invite (R11): the principal id IS the lowercased address.
        const key = `email_invite:${g.principalId}`;
        const principal: PrincipalRef = {
          kind: 'email_invite',
          id: g.principalId,
          label: g.principalId,
        };
        const entry: AccessEntry = entries.get(key) ?? {
          principal,
          orgRole: null,
          email: g.principalId,
          grants: [],
        };
        entry.grants.push(wire(g, principal));
        entries.set(key, entry);
        continue;
      }
      if (g.principalType === 'user') {
        const entry = userEntry(g.principalId);
        entry?.grants.push(wire(g, entry.principal));
        continue;
      }
      const group = groupRef.get(g.principalId);
      if (group === undefined) continue;
      const key = `group:${group.id}`;
      const entry: AccessEntry = entries.get(key) ?? {
        principal: group,
        orgRole: null,
        email: null,
        grants: [],
      };
      entry.grants.push(wire(g, group));
      entries.set(key, entry);
      for (const m of memberships) {
        if (m.groupId === group.id) userEntry(m.userId)?.grants.push(wire(g, group));
      }
    }
    return [...entries.values()];
  }

  /** The five built-ins in R2 order, then this org's live custom roles by name (R3). */
  private async pickerRoles(organizationId: string): Promise<AccessList['roles']> {
    const rows = await this.prisma.role.findMany({
      where: {
        isArchived: false,
        OR: [{ organizationId: null, isBuiltIn: true }, { organizationId }],
      },
      select: { key: true, name: true, atoms: true, isBuiltIn: true },
      orderBy: { name: 'asc' },
    });
    const order = BUILT_IN_ROLE_ORDER as readonly string[];
    const builtIns = rows
      .filter((r) => r.isBuiltIn && order.includes(r.key))
      .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    return [...builtIns, ...rows.filter((r) => !r.isBuiltIn)].map((r) => ({
      key: r.key,
      name: r.name,
      atoms: r.atoms,
      builtIn: r.isBuiltIn,
    }));
  }

  private managesAnything(map: ProjectPermissionMap, skel: ProjectSkeleton): boolean {
    if (map.projectAtoms.has('sharing:manage')) return true;
    for (const atoms of map.areaAtoms.values()) if (atoms.has('sharing:manage')) return true;
    return skel.entities.some((e) =>
      atomsAt(map, skel, { type: 'entity', id: e.id }).has('sharing:manage'),
    );
  }

  private async projectOrg(projectId: string): Promise<{ organizationId: string }> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
      select: { organizationId: true },
    });
    if (project === null)
      throw new NotFoundException({ code: 'not_found', resourceType: 'project', id: projectId });
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
        : await this.prisma.userGroup.findFirst({
            where: { id, organizationId },
            select: { id: true },
          });
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
