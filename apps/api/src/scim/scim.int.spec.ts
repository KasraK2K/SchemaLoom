import type { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionResolver } from '../access';
import { ScimTokenAuthService } from '../auth/scim-token-auth.service';
import { SignupPolicy } from '../auth/signup-policy';
import { SsoService } from '../auth/sso.service';
import type { ScimPrincipal } from '../auth/subject';
import { TokensService } from '../auth/tokens.service';
import type { AppEnv } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';
import { GroupsService } from '../organizations/groups.service';
import { MembersService } from '../organizations/members.service';
import type { PrismaService } from '../prisma/prisma.service';
import okta from './fixtures/okta.json';
import { ScimService } from './scim.service';

/**
 * Roadmap 14b §4 against a real Postgres (`DATABASE_URL_TEST`, migrated by CI's
 * `db:deploy`): deprovisioning, token revocation and a deleted managed group, through the
 * same services the routes call.
 */

const url = process.env.DATABASE_URL_TEST;
const TAG = 'scim-int';

describe.skipIf(url === undefined)('SCIM provisioning (roadmap 14b)', () => {
  const db = new PrismaClient({ datasourceUrl: url });
  const prisma = db as unknown as PrismaService;
  const env: Partial<AppEnv> = {
    API_PUBLIC_URL: 'https://sl.test',
    SIGNUP_MODE: 'invite',
    SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ACCESS_TOKEN_TTL: '15m',
    REFRESH_TOKEN_TTL: '30d',
    JWT_ACCESS_SECRET: 'access-secret-that-is-at-least-32-chars-long',
  };
  const config = {
    get: (key: keyof AppEnv) => env[key],
  } as unknown as ConfigService<AppEnv, true>;
  const resolver = { invalidate: () => Promise.resolve() } as unknown as PermissionResolver;
  const counts = new Map<string, number>();
  const redis = {
    incr: (key: string) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return Promise.resolve(counts.get(key));
    },
    expire: () => Promise.resolve(1),
  } as unknown as Redis;

  const members = new MembersService(prisma, resolver);
  const groups = new GroupsService(prisma, resolver);
  const signup = new SignupPolicy(prisma, config);
  const tokens = new TokensService(prisma, new JwtService({}), config);
  const scim = new ScimService(prisma, members, groups, signup, tokens, config);
  const sso = new SsoService(prisma, config, signup, groups);
  const auth = new ScimTokenAuthService(prisma, redis);

  const ORG = `org_${TAG}`;
  const OTHER = `org_${TAG}_other`;
  const PROJECT = `prj_${TAG}`;
  const id = (name: string) => `usr_${TAG}_${name}`;
  let principal: ScimPrincipal;
  let secret: string;

  const generation = async (userId: string) =>
    (await db.user.findUniqueOrThrow({ where: { id: userId } })).permGeneration;
  const isMember = async (userId: string, organizationId = ORG) =>
    (await db.orgMember.count({ where: { organizationId, userId } })) === 1;
  const liveSessions = (userId: string) => db.session.count({ where: { userId, revokedAt: null } });
  const liveApiTokens = (userId: string) =>
    db.apiToken.count({ where: { userId, revokedAt: null } });

  async function cleanup(): Promise<void> {
    await db.auditLog.deleteMany({ where: { organizationId: { in: [ORG, OTHER] } } });
    await db.organization.deleteMany({ where: { id: { in: [ORG, OTHER] } } });
    await db.user.deleteMany({ where: { email: { endsWith: `@${TAG}.test` } } });
  }

  beforeAll(async () => {
    await cleanup();
    await db.organization.create({ data: { id: ORG, name: TAG, slug: TAG } });
    await db.organization.create({
      data: { id: OTHER, name: `${TAG} other`, slug: `${TAG}-other` },
    });
    for (const name of ['owner', 'single', 'multi'])
      await db.user.create({ data: { id: id(name), email: `${name}@${TAG}.test`, name } });
    await db.orgMember.createMany({
      data: [
        { organizationId: ORG, userId: id('owner'), role: 'owner' },
        { organizationId: ORG, userId: id('single'), role: 'member' },
        { organizationId: ORG, userId: id('multi'), role: 'member' },
        { organizationId: OTHER, userId: id('multi'), role: 'member' },
      ],
    });
    const ws = await db.workspace.create({ data: { organizationId: ORG, name: 'W', slug: 'w' } });
    await db.project.create({
      data: {
        id: PROJECT,
        organizationId: ORG,
        workspaceId: ws.id,
        name: 'P',
        slug: 'p',
        engineId: 'postgresql',
        engineVersion: '16',
        enginePluginVersion: '1.0.0',
      },
    });
    const future = new Date(Date.now() + 86_400_000);
    for (const name of ['single', 'multi']) {
      await db.apiToken.create({
        data: {
          userId: id(name),
          projectId: PROJECT,
          name: 'ci',
          tokenHash: `${TAG}-${name}`,
          prefix: 'slt_x',
          scopes: ['read'],
          expiresAt: future,
        },
      });
      await db.session.create({
        data: {
          userId: id(name),
          refreshTokenHash: `${TAG}-${name}`,
          familyId: name,
          expiresAt: future,
        },
      });
    }
    const conn = await db.ssoConnection.create({
      data: {
        organizationId: ORG,
        protocol: 'oidc',
        name: 'IdP',
        domains: [`${TAG}.test`],
        oidcIssuer: 'https://idp.test',
        oidcClientId: 'sl',
        defaultOrgRole: 'guest',
      },
    });
    // Minted the way the settings page does it, by an owner.
    secret = (await sso.createScimToken(id('owner'), TAG, conn.id)).secret;
    principal = await auth.principalFor(secret);
  });

  afterAll(async () => {
    await cleanup();
    await db.$disconnect();
  });

  it('the token resolves to its connection and org', () => {
    expect(principal.organizationId).toBe(ORG);
  });

  it('deprovisioning a single-org user removes the membership, bumps permGeneration, revokes API tokens and ends sessions', async () => {
    const before = await generation(id('single'));
    const user = await scim.patchUser(principal, id('single'), okta.deactivateUser);

    expect(user).toMatchObject({ id: id('single'), active: false });
    expect(await isMember(id('single'))).toBe(false);
    expect(await generation(id('single'))).toBe(before + 1);
    expect(await liveApiTokens(id('single'))).toBe(0);
    expect(await liveSessions(id('single'))).toBe(0);
    const audit = await db.auditLog.findFirstOrThrow({
      where: { organizationId: ORG, action: 'org_member.removed', resourceId: id('single') },
    });
    expect(audit.actorUserId).toBeNull();
    expect(audit.metadata).toMatchObject({ via: 'scim' });
  });

  it('reactivation re-adds the membership with the connection role', async () => {
    await scim.patchUser(principal, id('single'), okta.reactivateUser);
    const row = await db.orgMember.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: ORG, userId: id('single') } },
    });
    expect(row.role).toBe('guest');
  });

  it('a multi-org user keeps their sessions; this org is cut, the other is untouched', async () => {
    await scim.deleteUser(principal, id('multi'));
    expect(await isMember(id('multi'))).toBe(false);
    expect(await isMember(id('multi'), OTHER)).toBe(true);
    expect(await liveApiTokens(id('multi'))).toBe(0);
    expect(await liveSessions(id('multi'))).toBe(1);
    // DELETE means gone from the directory's point of view.
    await expect(scim.getUser(principal, id('multi'))).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to deprovision an owner (409) and changes nothing', async () => {
    await expect(scim.deleteUser(principal, id('owner'))).rejects.toMatchObject({ status: 409 });
    expect(await isMember(id('owner'))).toBe(true);
  });

  it('a user outside the org is invisible: no probing or pulling in accounts by id', async () => {
    const stranger = await db.user.create({
      data: { email: `stranger@${TAG}.test`, name: 'S' },
    });
    await expect(scim.getUser(principal, stranger.id)).rejects.toMatchObject({ status: 404 });
    await expect(scim.patchUser(principal, stranger.id, okta.reactivateUser)).rejects.toMatchObject(
      { status: 404 },
    );
    expect(await isMember(stranger.id)).toBe(false);
  });

  it('creates an account through SignupPolicy even in invite-only mode, and refuses a duplicate', async () => {
    const created = await scim.createUser(principal, {
      userName: `New.Person@${TAG}.test`,
      name: { givenName: 'New', familyName: 'Person' },
      externalId: 'ext-1',
      active: true,
    });
    expect(created).toMatchObject({
      userName: `new.person@${TAG}.test`,
      displayName: 'New Person',
      externalId: 'ext-1',
      active: true,
    });
    const list = await scim.listUsers(principal, {
      filter: `userName eq "new.person@${TAG}.test"`,
    });
    expect(list.totalResults).toBe(1);
    await expect(
      scim.createUser(principal, { userName: `new.person@${TAG}.test` }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('deleting a managed group empties it but keeps it and its grants', async () => {
    const group = (await scim.createGroup(principal, {
      displayName: `Data ${TAG}`,
      members: [{ value: id('single') }, { value: id('multi') }],
    })) as { id: string; members: { value: string }[] };
    // `multi` left the org above, so only `single` joined (§1.4).
    expect(group.members.map((m) => m.value)).toEqual([id('single')]);

    const role = await db.role.create({
      data: { organizationId: ORG, key: `viewer-${TAG}`, name: 'Viewer', atoms: ['schema:view'] },
    });
    const grant = await db.accessGrant.create({
      data: {
        organizationId: ORG,
        projectId: PROJECT,
        resourceType: 'project',
        resourceId: PROJECT,
        principalType: 'group',
        principalId: group.id,
        roleId: role.id,
      },
    });

    const before = await generation(id('single'));
    await scim.deleteGroup(principal, group.id);
    const after = await db.userGroup.findUniqueOrThrow({
      where: { id: group.id },
      include: { members: true },
    });
    expect(after.managedBy).toBeNull();
    expect(after.members).toEqual([]);
    expect(await db.accessGrant.count({ where: { id: grant.id } })).toBe(1);
    expect(await generation(id('single'))).toBe(before + 1);
    // No longer the IdP's.
    await expect(scim.getGroup(principal, group.id)).rejects.toMatchObject({ status: 404 });
  });

  it('a revoked SCIM token is a 401 on the next request', async () => {
    const conn = principal.connectionId;
    await sso.revokeScimToken(id('owner'), TAG, conn);
    await expect(auth.principalFor(secret)).rejects.toMatchObject({ status: 401 });
    // So is anything that isn't a SCIM token at all.
    await expect(auth.principalFor('slt_whatever')).rejects.toMatchObject({ status: 401 });
    await expect(auth.principalFor(undefined)).rejects.toMatchObject({ status: 401 });
  });
});
