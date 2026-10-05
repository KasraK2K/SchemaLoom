import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppEnv } from '../config/env';
import type { OrgRole, Prisma, SsoProtocol } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { applyOrgAppearance } from './org-appearance';
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
}

/** The person the IdP vouched for. `email` is null when the IdP sent none we can trust. */
export interface SsoIdentity {
  readonly subject: string;
  readonly email: string | null;
  readonly name: string | null;
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
} satisfies Prisma.SsoConnectionSelect;

function toView(row: Prisma.SsoConnectionGetPayload<{ select: typeof VIEW }>): SsoConnectionView {
  const { oidcClientSecretEnc, ...rest } = row;
  return { ...rest, hasClientSecret: oidcClientSecretEnc !== null };
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
      const { count } = await tx.ssoConnection.deleteMany({ where: { id, organizationId } });
      if (count === 0) throw new NotFoundException({ code: 'not_found' });
      // Its identities sign in nowhere now; the accounts themselves stay.
      await tx.account.deleteMany({ where: { provider: ssoProvider(id) } });
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
    };
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
