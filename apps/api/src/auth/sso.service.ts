import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env';
import type { OrgRole, Prisma, SsoProtocol } from '../generated/prisma/client';
import { GroupsService } from '../organizations/groups.service';
import { PrismaService } from '../prisma/prisma.service';
import { applyOrgAppearance } from './org-appearance';
import { newScimToken } from './scim-token-auth.service';
import { SignupPolicy } from './signup-policy';
import { decryptSecret, encryptSecret } from './totp';

/**
 * Roadmap 14 §1 (`docs/phase14/DESIGN.md`) — SSO connections and the one decision that
 * matters for safety: which account an IdP's assertion becomes (§1.2).
 */

/** What a connection's settings page shows. The client secret never leaves the api. */
export interface SsoConnectionView {
  readonly id: string;
  readonly protocol: SsoProtocol;
  readonly name: string;
  readonly domains: string[];
  readonly oidcIssuer: string | null;
  readonly oidcClientId: string | null;
  readonly hasClientSecret: boolean;
  readonly samlEntryPoint: string | null;
  readonly samlIdpCert: string | null;
  readonly jit: boolean;
  readonly defaultOrgRole: OrgRole;
  readonly enforced: boolean;
  /** Roadmap 14b §2: the claim listing the person's groups; null = no sync at sign-in. */
  readonly groupsClaim: string | null;
  /** §1.1: the live SCIM token, never its secret. */
  readonly scim: { prefix: string; createdAt: Date; lastUsedAt: Date | null } | null;
  readonly groupMappings: { id: string; claimValue: string; groupId: string; groupName: string }[];
}

export interface SsoConnectionInput {
  readonly protocol: SsoProtocol;
  readonly name: string;
  readonly domains: string[];
  readonly oidcIssuer?: string | undefined;
  readonly oidcClientId?: string | undefined;
  /** absent on an edit: keep the stored one */
  readonly oidcClientSecret?: string | undefined;
  readonly samlEntryPoint?: string | undefined;
  readonly samlIdpCert?: string | undefined;
  readonly jit: boolean;
  readonly defaultOrgRole: 'member' | 'guest';
  readonly enforced: boolean;
  readonly groupsClaim?: string | undefined;
}

/** The connection as the sign-in flow needs it, secret decrypted. */
export interface SsoConnectionRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly protocol: SsoProtocol;
  readonly domains: string[];
  readonly oidcIssuer: string | null;
  readonly oidcClientId: string | null;
  readonly oidcClientSecret: string | null;
  readonly samlEntryPoint: string | null;
  readonly samlIdpCert: string | null;
  readonly jit: boolean;
  readonly defaultOrgRole: OrgRole;
  readonly groupsClaim: string | null;
}

/** The person the IdP vouched for. `email` is null when the IdP sent none we can trust. */
export interface SsoIdentity {
  readonly subject: string;
  readonly email: string | null;
  readonly name: string | null;
  /** Roadmap 14b §2: the groups claim's values; absent when the connection has none. */
  readonly groups?: readonly string[] | undefined;
}

export type SsoRefusal = 'no_email' | 'not_member' | 'link_refused' | 'no_account';
export type SsoOutcome = { readonly userId: string } | { readonly refused: SsoRefusal };

export const ssoProvider = (connectionId: string): string => `sso:${connectionId}`;

/** As `normalizeEmail` in auth.service, which imports this file (so no import back). */
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

const VIEW = {
  id: true,
  protocol: true,
  name: true,
  domains: true,
  oidcIssuer: true,
  oidcClientId: true,
  oidcClientSecretEnc: true,
  samlEntryPoint: true,
  samlIdpCert: true,
  jit: true,
  defaultOrgRole: true,
  enforced: true,
  groupsClaim: true,
  scimTokens: {
    where: { revokedAt: null },
    select: { prefix: true, createdAt: true, lastUsedAt: true },
  },
  groupMappings: {
    select: { id: true, claimValue: true, groupId: true, group: { select: { name: true } } },
    orderBy: { claimValue: 'asc' },
  },
} satisfies Prisma.SsoConnectionSelect;

function toView(row: Prisma.SsoConnectionGetPayload<{ select: typeof VIEW }>): SsoConnectionView {
  const { oidcClientSecretEnc, scimTokens, groupMappings, ...rest } = row;
  return {
    ...rest,
    hasClientSecret: oidcClientSecretEnc !== null,
    scim: scimTokens[0] ?? null,
    groupMappings: groupMappings.map(({ group, ...m }) => ({ ...m, groupName: group.name })),
  };
}

/**
 * Enforcement (§1.3): the connection that requires this user to sign in through SSO, if
 * any. Only members of the connection's org, never its owners, and only for the
 * connection's domains. Every non-SSO login passes through `AuthService.issueSession`,
 * which asks this before anything else.
 */
export async function enforcedConnectionFor(
  prisma: PrismaService,
  userId: string,
): Promise<{ id: string; name: string } | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (user === null) return null;
  return prisma.ssoConnection.findFirst({
    where: {
      enforced: true,
      domains: { has: emailDomain(user.email) },
      organization: {
        deletedAt: null,
        members: { some: { userId, role: { not: 'owner' } } },
      },
    },
    select: { id: true, name: true },
  });
}

@Injectable()
export class SsoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppEnv, true>,
    private readonly signup: SignupPolicy,
    private readonly groups: GroupsService,
  ) {}

  private get key(): string {
    return this.config.get('SECRETS_ENCRYPTION_KEY', { infer: true });
  }

  /** Q2: owners only. A non-member gets the 404 of a missing org, like every org route. */
  private async ownedOrg(userId: string, orgSlug: string): Promise<string> {
    const member = await this.prisma.orgMember.findFirst({
      where: { userId, organization: { slug: orgSlug, deletedAt: null } },
      select: { organizationId: true, role: true },
    });
    if (member === null) throw new NotFoundException({ code: 'not_found' });
    if (member.role !== 'owner')
      throw new ForbiddenException({ code: 'forbidden_org_role', required: ['owner'] });
    return member.organizationId;
  }

  async list(userId: string, orgSlug: string): Promise<SsoConnectionView[]> {
    const organizationId = await this.ownedOrg(userId, orgSlug);
    const rows = await this.prisma.ssoConnection.findMany({
      where: { organizationId },
      select: VIEW,
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(toView);
  }

  private data(input: SsoConnectionInput): Prisma.SsoConnectionUncheckedUpdateInput {
    const oidc = input.protocol === 'oidc';
    return {
      protocol: input.protocol,
      name: input.name,
      domains: [...new Set(input.domains.map((d) => d.trim().toLowerCase()))],
      oidcIssuer: oidc ? (input.oidcIssuer ?? null) : null,
      oidcClientId: oidc ? (input.oidcClientId ?? null) : null,
      ...(oidc
        ? input.oidcClientSecret === undefined
          ? {}
          : { oidcClientSecretEnc: encryptSecret(Buffer.from(input.oidcClientSecret), this.key) }
        : { oidcClientSecretEnc: null }),
      samlEntryPoint: oidc ? null : (input.samlEntryPoint ?? null),
      samlIdpCert: oidc ? null : (input.samlIdpCert ?? null),
      jit: input.jit,
      defaultOrgRole: input.defaultOrgRole,
      enforced: input.enforced,
      groupsClaim: input.groupsClaim?.trim() ? input.groupsClaim.trim() : null,
    };
  }

  async create(
    userId: string,
    orgSlug: string,
    input: SsoConnectionInput,
  ): Promise<SsoConnectionView> {
    const organizationId = await this.ownedOrg(userId, orgSlug);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.ssoConnection.create({
        data: { ...(this.data(input) as Prisma.SsoConnectionUncheckedCreateInput), organizationId },
        select: VIEW,
      });
      await this.audit(tx, organizationId, userId, 'sso_connection.created', row.id, {
        protocol: row.protocol,
        domains: row.domains,
        enforced: row.enforced,
      });
      return toView(row);
    });
  }

  async update(
    userId: string,
    orgSlug: string,
    id: string,
    input: SsoConnectionInput,
  ): Promise<SsoConnectionView> {
    const organizationId = await this.ownedOrg(userId, orgSlug);
    return this.prisma.$transaction(async (tx) => {
      const found = await tx.ssoConnection.findFirst({ where: { id, organizationId } });
      if (found === null) throw new NotFoundException({ code: 'not_found' });
      const row = await tx.ssoConnection.update({
        where: { id },
        data: this.data(input),
        select: VIEW,
      });
      await this.audit(tx, organizationId, userId, 'sso_connection.updated', id, {
        protocol: row.protocol,
        domains: row.domains,
        enforced: row.enforced,
        jit: row.jit,
      });
      return toView(row);
    });
  }

  async remove(userId: string, orgSlug: string, id: string): Promise<void> {
    const organizationId = await this.ownedOrg(userId, orgSlug);
    await this.prisma.$transaction(async (tx) => {
      const mapped = await tx.ssoGroupMapping.findMany({
        where: { ssoConnectionId: id },
        select: { groupId: true },
      });
      const { count } = await tx.ssoConnection.deleteMany({ where: { id, organizationId } });
      if (count === 0) throw new NotFoundException({ code: 'not_found' });
      // Its identities sign in nowhere now; the accounts themselves stay.
      await tx.account.deleteMany({ where: { provider: ssoProvider(id) } });
      // Roadmap 14b: the groups it filled go back to people, members and grants intact.
      // SCIM groups only once no other connection of the org still has a live token.
      await tx.userGroup.updateMany({
        where: {
          id: { in: mapped.map((m) => m.groupId) },
          managedBy: 'claim',
          ssoMappings: { none: {} },
        },
        data: { managedBy: null },
      });
      const scimLeft = await tx.scimToken.count({
        where: { revokedAt: null, connection: { organizationId } },
      });
      if (scimLeft === 0)
        await tx.userGroup.updateMany({
          where: { organizationId, managedBy: 'scim' },
          data: { managedBy: null, scimExternalId: null },
        });
      await this.audit(tx, organizationId, userId, 'sso_connection.deleted', id, {});
    });
  }

  /** §1.1 — which connections sign this address in. Names only: nothing a button wouldn't show. */
  async discover(rawEmail: string): Promise<{ id: string; name: string }[]> {
    return this.prisma.ssoConnection.findMany({
      where: {
        domains: { has: emailDomain(normalizeEmail(rawEmail)) },
        organization: { deletedAt: null },
      },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async record(id: string): Promise<SsoConnectionRecord> {
    const row = await this.prisma.ssoConnection.findFirst({
      where: { id, organization: { deletedAt: null } },
    });
    if (row === null) throw new NotFoundException({ code: 'not_found' });
    return {
      id: row.id,
      organizationId: row.organizationId,
      protocol: row.protocol,
      domains: row.domains,
      oidcIssuer: row.oidcIssuer,
      oidcClientId: row.oidcClientId,
      oidcClientSecret:
        row.oidcClientSecretEnc === null
          ? null
          : decryptSecret(row.oidcClientSecretEnc, this.key).toString(),
      samlEntryPoint: row.samlEntryPoint,
      samlIdpCert: row.samlIdpCert,
      jit: row.jit,
      defaultOrgRole: row.defaultOrgRole,
      groupsClaim: row.groupsClaim,
    };
  }

  // ------------------------------------------------- roadmap 14b: directory sync (owners)

  /**
   * §1.1 — one live SCIM token per connection: a new one revokes the old in the same
   * transaction (a partial unique index backs it). The secret is returned once.
   */
  async createScimToken(
    userId: string,
    orgSlug: string,
    id: string,
  ): Promise<{ secret: string; prefix: string }> {
    const organizationId = await this.ownedOrg(userId, orgSlug);
    const token = newScimToken();
    await this.prisma.$transaction(async (tx) => {
      await this.connectionOf(tx, organizationId, id);
      const revoked = await tx.scimToken.updateMany({
        where: { ssoConnectionId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      await tx.scimToken.create({
        data: {
          ssoConnectionId: id,
          tokenHash: token.tokenHash,
          prefix: token.prefix,
          createdById: userId,
        },
      });
      await this.audit(tx, organizationId, userId, 'scim_token.created', id, {
        prefix: token.prefix,
        replaced: revoked.count > 0,
      });
    });
    return { secret: token.secret, prefix: token.prefix };
  }

  /** Revoked at once: the next SCIM request with it is a 401. */
  async revokeScimToken(userId: string, orgSlug: string, id: string): Promise<void> {
    const organizationId = await this.ownedOrg(userId, orgSlug);
    await this.prisma.$transaction(async (tx) => {
      await this.connectionOf(tx, organizationId, id);
      const { count } = await tx.scimToken.updateMany({
        where: { ssoConnectionId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (count === 0) throw new NotFoundException({ code: 'not_found' });
      await this.audit(tx, organizationId, userId, 'scim_token.revoked', id, {});
    });
  }

  /**
   * §2 — a claim value fills a group, which becomes read-only (`managedBy: 'claim'`). A SCIM
   * group can't also be claim-mapped (D4, one source per group).
   */
  async addGroupMapping(
    userId: string,
    orgSlug: string,
    id: string,
    input: { claimValue: string; groupId: string },
  ): Promise<void> {
    const organizationId = await this.ownedOrg(userId, orgSlug);
    const claimValue = input.claimValue.trim();
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.connectionOf(tx, organizationId, id);
        const group = await tx.userGroup.findFirst({
          where: { id: input.groupId, organizationId },
          select: { managedBy: true },
        });
        if (group === null)
          throw new NotFoundException({ code: 'not_found', resourceType: 'group' });
        if (group.managedBy === 'scim')
          throw new ConflictException({ code: 'group_managed', managedBy: 'scim' });
        await tx.userGroup.update({ where: { id: input.groupId }, data: { managedBy: 'claim' } });
        await tx.ssoGroupMapping.create({
          data: { ssoConnectionId: id, claimValue, groupId: input.groupId },
        });
        await this.audit(tx, organizationId, userId, 'sso_group_mapping.created', id, {
          claimValue,
          groupId: input.groupId,
        });
      });
    } catch (error) {
      if ((error as { code?: unknown }).code === 'P2002')
        throw new ConflictException({ code: 'mapping_exists' });
      throw error;
    }
  }

  /** The group goes back to people once nothing maps to it. Its members stay. */
  async removeGroupMapping(
    userId: string,
    orgSlug: string,
    id: string,
    mappingId: string,
  ): Promise<void> {
    const organizationId = await this.ownedOrg(userId, orgSlug);
    await this.prisma.$transaction(async (tx) => {
      await this.connectionOf(tx, organizationId, id);
      const mapping = await tx.ssoGroupMapping.findFirst({
        where: { id: mappingId, ssoConnectionId: id },
        select: { claimValue: true, groupId: true },
      });
      if (mapping === null) throw new NotFoundException({ code: 'not_found' });
      await tx.ssoGroupMapping.delete({ where: { id: mappingId } });
      await tx.userGroup.updateMany({
        where: { id: mapping.groupId, managedBy: 'claim', ssoMappings: { none: {} } },
        data: { managedBy: null },
      });
      await this.audit(tx, organizationId, userId, 'sso_group_mapping.deleted', id, mapping);
    });
  }

  /**
   * §2 — on every SSO sign-in, mapped groups only: in when the claim lists one of the
   * group's values, out when it lists none. Groups nobody mapped are never touched. Goes
   * through `GroupsService`, so the bumps and audit rows (`via: 'sso'`) are the usual ones.
   * ponytail: only as fresh as the last sign-in (the doc's known ceiling); SCIM is real time.
   */
  async syncClaimGroups(
    conn: SsoConnectionRecord,
    userId: string,
    identity: SsoIdentity,
  ): Promise<void> {
    if (conn.groupsClaim === null || identity.groups === undefined) return;
    const mappings = await this.prisma.ssoGroupMapping.findMany({
      where: { ssoConnectionId: conn.id },
      select: { claimValue: true, groupId: true },
    });
    const listed = new Set(identity.groups);
    const wanted = new Map<string, boolean>();
    for (const m of mappings)
      wanted.set(m.groupId, (wanted.get(m.groupId) ?? false) || listed.has(m.claimValue));
    for (const [groupId, inGroup] of wanted) {
      if (inGroup)
        await this.groups.addMemberByDirectory(conn.organizationId, groupId, userId, 'sso');
      else await this.groups.removeMemberByDirectory(conn.organizationId, groupId, userId, 'sso');
    }
  }

  private async connectionOf(
    tx: Prisma.TransactionClient,
    organizationId: string,
    id: string,
  ): Promise<void> {
    const found = await tx.ssoConnection.findFirst({
      where: { id, organizationId },
      select: { id: true },
    });
    if (found === null) throw new NotFoundException({ code: 'not_found' });
  }

  /**
   * §1.2 — the IdP is trusted only for its own organisation:
   *  1. a known identity signs in as its user;
   *  2. an existing user with that email is linked only when every org they belong to is
   *     this connection's org (an owner could otherwise point an IdP at a member's address
   *     and walk into that member's other organisations);
   *  3. otherwise, with JIT on and the domain listed, a new member is created;
   *  4. otherwise nothing.
   * Refusals are audited under the connection's org.
   */
  async resolve(conn: SsoConnectionRecord, identity: SsoIdentity): Promise<SsoOutcome> {
    const outcome = await this.resolveInner(conn, identity);
    if ('refused' in outcome)
      await this.prisma.auditLog.create({
        data: {
          organizationId: conn.organizationId,
          action: 'auth.sso_refused',
          resourceType: 'sso_connection',
          resourceId: conn.id,
          actorEmail: identity.email,
          metadata: { reason: outcome.refused },
        },
      });
    return outcome;
  }

  private async resolveInner(
    conn: SsoConnectionRecord,
    identity: SsoIdentity,
  ): Promise<SsoOutcome> {
    const provider = ssoProvider(conn.id);
    const known = await this.prisma.account.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId: identity.subject } },
      select: { userId: true },
    });
    if (known !== null) return { userId: known.userId };
    if (identity.email === null) return { refused: 'no_email' };
    const email = normalizeEmail(identity.email);

    const existing = await this.prisma.user.findFirst({
      where: { email },
      select: { id: true, orgMemberships: { select: { organizationId: true } } },
    });
    if (existing !== null) {
      const orgs = existing.orgMemberships.map((m) => m.organizationId);
      if (!orgs.includes(conn.organizationId)) return { refused: 'not_member' };
      if (orgs.some((o) => o !== conn.organizationId)) return { refused: 'link_refused' };
      await this.prisma.account.create({
        data: { userId: existing.id, provider, providerAccountId: identity.subject },
      });
      return { userId: existing.id };
    }

    if (!conn.jit || !conn.domains.includes(emailDomain(email))) return { refused: 'no_account' };
    const userId = await this.signup.createUser(
      email,
      { emailProven: true, ssoOrgId: conn.organizationId },
      async (tx) => {
        const user = await tx.user.create({
          data: { email, name: identity.name ?? email, emailVerifiedAt: new Date() },
          select: { id: true },
        });
        await tx.orgMember.create({
          data: { organizationId: conn.organizationId, userId: user.id, role: conn.defaultOrgRole },
        });
        await applyOrgAppearance(tx, user.id, conn.organizationId);
        await tx.account.create({
          data: { userId: user.id, provider, providerAccountId: identity.subject },
        });
        await tx.auditLog.create({
          data: {
            organizationId: conn.organizationId,
            actorUserId: user.id,
            action: 'org_member.added',
            resourceType: 'user',
            resourceId: user.id,
            metadata: { role: conn.defaultOrgRole, ssoConnectionId: conn.id },
          },
        });
        return user.id;
      },
    );
    return { userId };
  }

  private audit(
    tx: Prisma.TransactionClient,
    organizationId: string,
    actorUserId: string,
    action: string,
    connectionId: string,
    metadata: Prisma.InputJsonValue,
  ): Promise<unknown> {
    return tx.auditLog.create({
      data: {
        organizationId,
        actorUserId,
        action,
        resourceType: 'sso_connection',
        resourceId: connectionId,
        metadata,
      },
    });
  }
}
