import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env';
import { applyOrgAppearance } from '../auth/org-appearance';
import { SignupPolicy } from '../auth/signup-policy';
import type { ScimPrincipal } from '../auth/subject';
import { TokensService } from '../auth/tokens.service';
import type { OrgRole } from '../generated/prisma/client';
import { GroupsService, MembersService, type GroupView } from '../organizations';
import { PrismaService } from '../prisma/prisma.service';
import {
  SCHEMA,
  groupPatch,
  groupResource,
  nameOf,
  parseFilter,
  parsePage,
  scimBadRequest,
  userPatch,
  userResource,
  type GroupChanges,
  type UserChanges,
} from './scim.protocol';

/**
 * Roadmap 14b §1.3–§1.4 (`docs/phase14/DIRECTORY-SYNC.md`) — SCIM Users and Groups for the
 * org the token's connection belongs to. Every membership change goes through
 * `MembersService` and `GroupsService`, so locks, `permGeneration` bumps and audit rows are
 * the ones people's changes get, with no actor and `via: 'scim'`.
 */

type Json = Record<string, unknown>;

interface ListResponse {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: Json[];
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const notFound = (): NotFoundException =>
  new NotFoundException({ code: 'not_found', message: 'Resource not found' });

@Injectable()
export class ScimService {
  private readonly base: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly members: MembersService,
    private readonly groups: GroupsService,
    private readonly signup: SignupPolicy,
    private readonly tokens: TokensService,
    config: ConfigService<AppEnv, true>,
  ) {
    this.base = `${config.get('API_PUBLIC_URL', { infer: true }).replace(/\/+$/, '')}/api/scim/v2`;
  }

  // ------------------------------------------------------------------------------ Users

  async listUsers(scim: ScimPrincipal, query: Json): Promise<ListResponse> {
    const filter = parseFilter(query.filter, ['username', 'externalid']);
    const { skip, take } = parsePage(query.startIndex, query.count);
    const where = {
      organizationId: scim.organizationId,
      ...(filter?.attribute === 'username'
        ? { user: { email: normalizeEmail(filter.value) } }
        : filter?.attribute === 'externalid'
          ? { scimExternalId: filter.value }
          : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.orgMember.count({ where }),
      this.prisma.orgMember.findMany({
        where,
        select: { scimExternalId: true, user: { select: USER } },
        orderBy: { createdAt: 'asc' },
        skip,
        take,
      }),
    ]);
    return this.list(
      total,
      skip,
      rows.map((r) => this.userJson(r.user, true, r.scimExternalId)),
    );
  }

  async getUser(scim: ScimPrincipal, userId: string): Promise<Json> {
    const known = await this.known(scim, userId);
    return this.userJson(known.user, known.member, known.externalId);
  }

  /**
   * §1.3 — `userName` is the email. A new address gets an account (verified, no password)
   * through `SignupPolicy` with the `scimOrgId` proof; an existing account only gains the
   * membership. SCIM never links an SSO identity: rule 1.2.2 does that at first sign-in.
   */
  async createUser(scim: ScimPrincipal, body: unknown): Promise<Json> {
    const changes = userResource(body);
    const raw = changes.userName ?? changes.email;
    if (raw === undefined || !EMAIL.test(raw))
      throw scimBadRequest('invalidValue', 'userName must be an email address');
    if (changes.active === false)
      throw scimBadRequest('invalidValue', 'Users are created active; deactivate them afterwards');
    const email = normalizeEmail(raw);
    const role = await this.defaultRole(scim);
    const externalId = changes.externalId ?? null;

    const existing = await this.prisma.user.findFirst({ where: { email }, select: { id: true } });
    if (existing !== null) {
      if (
        !(await this.members.addByDirectory(
          scim.organizationId,
          existing.id,
          role,
          externalId,
          'scim',
        ))
      )
        throw new ConflictException({
          code: 'scim_exists',
          scimType: 'uniqueness',
          message: 'This user is already a member',
        });
      return this.getUser(scim, existing.id);
    }

    const userId = await this.signup.createUser(
      email,
      { emailProven: true, scimOrgId: scim.organizationId },
      async (tx) => {
        const user = await tx.user.create({
          data: { email, name: nameOf(changes) ?? email, emailVerifiedAt: new Date() },
          select: { id: true },
        });
        await tx.orgMember.create({
          data: {
            organizationId: scim.organizationId,
            userId: user.id,
            role,
            scimExternalId: externalId,
          },
        });
        await applyOrgAppearance(tx, user.id, scim.organizationId);
        await tx.auditLog.create({
          data: {
            organizationId: scim.organizationId,
            action: 'org_member.added',
            resourceType: 'user',
            resourceId: user.id,
            metadata: { role, via: 'scim', ssoConnectionId: scim.connectionId },
          },
        });
        return user.id;
      },
    );
    return this.getUser(scim, userId);
  }

  replaceUser(scim: ScimPrincipal, userId: string, body: unknown): Promise<Json> {
    return this.applyUser(scim, userId, userResource(body));
  }

  patchUser(scim: ScimPrincipal, userId: string, body: unknown): Promise<Json> {
    return this.applyUser(scim, userId, userPatch(body));
  }

  /** `DELETE` deprovisions like `active: false`; a later `GET` is 404. */
  async deleteUser(scim: ScimPrincipal, userId: string): Promise<void> {
    const known = await this.known(scim, userId);
    if (known.member) await this.deprovision(scim, userId, true);
    else await this.markDeleted(scim, userId);
  }

  private async applyUser(
    scim: ScimPrincipal,
    userId: string,
    changes: UserChanges,
  ): Promise<Json> {
    const known = await this.known(scim, userId);
    // §1.3: the account may belong to other orgs too, so the IdP doesn't own its email.
    for (const email of [changes.userName, changes.email])
      if (email !== undefined && normalizeEmail(email) !== known.user.email)
        throw new ConflictException({
          code: 'scim_email_change',
          scimType: 'mutability',
          message: 'Email changes are made in SchemaLoom',
        });

    const name = nameOf(changes);
    if (name !== undefined && name !== known.user.name) {
      await this.prisma.$transaction([
        this.prisma.user.update({ where: { id: userId }, data: { name } }),
        this.prisma.auditLog.create({
          data: {
            organizationId: scim.organizationId,
            action: 'org_member.updated',
            resourceType: 'user',
            resourceId: userId,
            metadata: { via: 'scim', name: { before: known.user.name, after: name } },
          },
        }),
      ]);
    }

    let member = known.member;
    if (changes.active === false && member) {
      await this.deprovision(scim, userId, false);
      member = false;
    } else if (changes.active === true && !member) {
      await this.members.addByDirectory(
        scim.organizationId,
        userId,
        await this.defaultRole(scim),
        changes.externalId ?? known.externalId,
        'scim',
      );
      member = true;
    }
    if (member && changes.externalId !== undefined && changes.externalId !== known.externalId)
      await this.prisma.orgMember.update({
        where: { organizationId_userId: { organizationId: scim.organizationId, userId } },
        data: { scimExternalId: changes.externalId },
      });
    return this.getUser(scim, userId);
  }

  /**
   * §1.3 — `MembersService.removeByDirectory` (owners refused, groups dropped, grants inert,
   * `permGeneration` bumped), then this user's API tokens on the org's projects. Sessions
   * end only when the user is in no other org: they also serve the others, and this org is
   * already cut off because the resolver re-reads membership.
   */
  private async deprovision(scim: ScimPrincipal, userId: string, deleted: boolean): Promise<void> {
    await this.members.removeByDirectory(scim.organizationId, userId, 'scim', { deleted });
    const tokens = await this.prisma.apiToken.updateMany({
      where: { userId, revokedAt: null, project: { organizationId: scim.organizationId } },
      data: { revokedAt: new Date() },
    });
    if (tokens.count > 0)
      await this.prisma.auditLog.create({
        data: {
          organizationId: scim.organizationId,
          action: 'api_token.revoked',
          resourceType: 'user',
          resourceId: userId,
          metadata: { via: 'scim', count: tokens.count },
        },
      });
    if ((await this.prisma.orgMember.count({ where: { userId } })) === 0)
      await this.tokens.revokeAllForUser(userId);
  }

  /** DELETE of someone already deactivated: remembered, so their `GET` is a 404 from now. */
  private async markDeleted(scim: ScimPrincipal, userId: string): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        organizationId: scim.organizationId,
        action: 'org_member.removed',
        resourceType: 'user',
        resourceId: userId,
        metadata: { via: 'scim', deleted: true },
      },
    });
  }

  /**
   * The users this org's directory may see: members, and people it deprovisioned (so
   * Okta's reactivation finds them). Anyone else is 404, so a token can't probe or
   * pull in arbitrary accounts by id.
   */
  private async known(
    scim: ScimPrincipal,
    userId: string,
  ): Promise<{ user: UserRow; member: boolean; externalId: string | null }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: USER });
    if (user === null) throw notFound();
    const membership = await this.prisma.orgMember.findUnique({
      where: { organizationId_userId: { organizationId: scim.organizationId, userId } },
      select: { scimExternalId: true },
    });
    if (membership !== null) return { user, member: true, externalId: membership.scimExternalId };
    const removed = await this.prisma.auditLog.findFirst({
      where: {
        organizationId: scim.organizationId,
        action: 'org_member.removed',
        resourceId: userId,
        metadata: { path: ['via'], equals: 'scim' },
      },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });
    if (removed === null || (removed.metadata as { deleted?: unknown }).deleted === true)
      throw notFound();
    return { user, member: false, externalId: null };
  }

  private async defaultRole(scim: ScimPrincipal): Promise<OrgRole> {
    const conn = await this.prisma.ssoConnection.findUniqueOrThrow({
      where: { id: scim.connectionId },
      select: { defaultOrgRole: true },
    });
    return conn.defaultOrgRole;
  }

  private userJson(user: UserRow, active: boolean, externalId: string | null): Json {
    return {
      schemas: [SCHEMA.user],
      id: user.id,
      ...(externalId === null ? {} : { externalId }),
      userName: user.email,
      name: { formatted: user.name },
      displayName: user.name,
      emails: [{ value: user.email, type: 'work', primary: true }],
      active,
      meta: {
        resourceType: 'User',
        created: user.createdAt.toISOString(),
        lastModified: user.updatedAt.toISOString(),
        location: `${this.base}/Users/${user.id}`,
      },
    };
  }

  // ----------------------------------------------------------------------------- Groups

  async listGroups(scim: ScimPrincipal, query: Json): Promise<ListResponse> {
    const filter = parseFilter(query.filter, ['displayname', 'externalid']);
    const { skip, take } = parsePage(query.startIndex, query.count);
    const where = {
      organizationId: scim.organizationId,
      managedBy: 'scim',
      ...(filter?.attribute === 'displayname'
        ? { name: { equals: filter.value, mode: 'insensitive' as const } }
        : filter?.attribute === 'externalid'
          ? { scimExternalId: filter.value }
          : {}),
    };
    const excluded = typeof query.excludedAttributes === 'string' ? query.excludedAttributes : '';
    const withMembers = !excluded.toLowerCase().includes('members');
    const [total, rows] = await Promise.all([
      this.prisma.userGroup.count({ where }),
      this.prisma.userGroup.findMany({
        where,
        select: GROUP,
        orderBy: { createdAt: 'asc' },
        skip,
        take,
      }),
    ]);
    return this.list(
      total,
      skip,
      rows.map((g) => this.groupJson(g, withMembers)),
    );
  }

  async getGroup(scim: ScimPrincipal, groupId: string): Promise<Json> {
    return this.groupJson(await this.managed(scim, groupId), true);
  }

  async createGroup(scim: ScimPrincipal, body: unknown): Promise<Json> {
    const changes = groupResource(body);
    if (changes.displayName === undefined)
      throw scimBadRequest('invalidValue', 'displayName is required');
    let group: GroupView;
    try {
      group = await this.groups.createByDirectory(
        scim.organizationId,
        changes.displayName,
        changes.externalId ?? null,
      );
    } catch (error) {
      throw uniqueness(error);
    }
    await this.applyMembers(scim, group.id, { ...changes, displayName: undefined });
    return this.getGroup(scim, group.id);
  }

  async replaceGroup(scim: ScimPrincipal, groupId: string, body: unknown): Promise<Json> {
    return this.applyGroup(scim, groupId, groupResource(body));
  }

  async patchGroup(scim: ScimPrincipal, groupId: string, body: unknown): Promise<Json> {
    return this.applyGroup(scim, groupId, groupPatch(body));
  }

  /** §1.4 / Q4 — emptied and handed back as a normal group; its grants survive. */
  async deleteGroup(scim: ScimPrincipal, groupId: string): Promise<void> {
    await this.managed(scim, groupId);
    await this.groups.releaseByDirectory(scim.organizationId, groupId);
  }

  private async applyGroup(
    scim: ScimPrincipal,
    groupId: string,
    changes: GroupChanges,
  ): Promise<Json> {
    const group = await this.managed(scim, groupId);
    if (
      (changes.displayName !== undefined && changes.displayName !== group.name) ||
      (changes.externalId !== undefined && changes.externalId !== group.scimExternalId)
    ) {
      try {
        await this.groups.renameByDirectory(scim.organizationId, groupId, {
          name: changes.displayName,
          scimExternalId: changes.externalId,
        });
      } catch (error) {
        throw uniqueness(error);
      }
    }
    await this.applyMembers(scim, groupId, changes);
    return this.getGroup(scim, groupId);
  }

  /** Members not in the org are skipped (§1.4): the IdP may push a group before the people. */
  private async applyMembers(
    scim: ScimPrincipal,
    groupId: string,
    changes: GroupChanges,
  ): Promise<void> {
    const current = new Set(
      (
        await this.prisma.groupMember.findMany({ where: { groupId }, select: { userId: true } })
      ).map((m) => m.userId),
    );
    const target = new Set(changes.replace ?? current);
    for (const id of changes.add) target.add(id);
    for (const id of changes.remove) target.delete(id);
    for (const id of current)
      if (!target.has(id))
        await this.groups.removeMemberByDirectory(scim.organizationId, groupId, id, 'scim');
    for (const id of target)
      if (!current.has(id))
        await this.groups.addMemberByDirectory(scim.organizationId, groupId, id, 'scim');
  }

  /** A SCIM-managed group of this org; any other group is invisible here (404). */
  private async managed(scim: ScimPrincipal, groupId: string) {
    const group = await this.prisma.userGroup.findFirst({
      where: { id: groupId, organizationId: scim.organizationId, managedBy: 'scim' },
      select: GROUP,
    });
    if (group === null) throw notFound();
    return group;
  }

  private groupJson(group: GroupRow, withMembers: boolean): Json {
    return {
      schemas: [SCHEMA.group],
      id: group.id,
      ...(group.scimExternalId === null ? {} : { externalId: group.scimExternalId }),
      displayName: group.name,
      ...(withMembers
        ? { members: group.members.map((m) => ({ value: m.user.id, display: m.user.email })) }
        : {}),
      meta: {
        resourceType: 'Group',
        created: group.createdAt.toISOString(),
        lastModified: group.updatedAt.toISOString(),
        location: `${this.base}/Groups/${group.id}`,
      },
    };
  }

  private list(total: number, skip: number, resources: Json[]): ListResponse {
    return {
      schemas: [SCHEMA.list],
      totalResults: total,
      startIndex: skip + 1,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  }
}

/** `group_name_taken` is SCIM's `uniqueness`. */
function uniqueness(error: unknown): unknown {
  if (error instanceof ConflictException)
    return new ConflictException({
      code: 'group_name_taken',
      scimType: 'uniqueness',
      message: 'A group with this name already exists',
    });
  return error;
}

const USER = { id: true, email: true, name: true, createdAt: true, updatedAt: true } as const;
interface UserRow {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

const GROUP = {
  id: true,
  name: true,
  scimExternalId: true,
  createdAt: true,
  updatedAt: true,
  members: { select: { user: { select: { id: true, email: true } } } },
} as const;
interface GroupRow {
  id: string;
  name: string;
  scimExternalId: string | null;
  createdAt: Date;
  updatedAt: Date;
  members: { user: { id: string; email: string } }[];
}
