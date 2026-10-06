import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../config/env';
import type { GroupsService } from '../organizations/groups.service';
import type { PrismaService } from '../prisma/prisma.service';
import { groupsOf } from './sso.protocols';
import type { SignupPolicy } from './signup-policy';
import {
  SsoService,
  emailDomain,
  enforcedConnectionFor,
  type SsoConnectionRecord,
} from './sso.service';

const ORG = 'org_acme';
const OTHER = 'org_other';

const conn = (over: Partial<SsoConnectionRecord> = {}): SsoConnectionRecord => ({
  id: 'sso1',
  organizationId: ORG,
  protocol: 'oidc',
  domains: ['acme.com'],
  oidcIssuer: 'https://idp.acme.com',
  oidcClientId: 'schemaloom',
  oidcClientSecret: 'secret',
  samlEntryPoint: null,
  samlIdpCert: null,
  jit: false,
  defaultOrgRole: 'member',
  groupsClaim: null,
  ...over,
});

interface World {
  /** `organizations.settings` of ORG. */
  orgSettings?: unknown;
  accounts?: { provider: string; providerAccountId: string; userId: string }[];
  users?: { id: string; email: string; orgs: string[] }[];
}

function setup(world: World = {}) {
  const accounts = [...(world.accounts ?? [])];
  const users = world.users ?? [];
  const created: { users: unknown[]; members: unknown[]; audits: { action: string }[] } = {
    users: [],
    members: [],
    audits: [],
  };
  const tx = {
    organization: {
      findUnique: vi.fn(() => Promise.resolve({ settings: world.orgSettings ?? {} })),
    },
    user: {
      create: vi.fn(({ data }: { data: unknown }) => {
        created.users.push(data);
        return Promise.resolve({ id: 'new_user' });
      }),
      update: vi.fn(() => Promise.resolve({})),
    },
    orgMember: {
      create: vi.fn(({ data }: { data: unknown }) => {
        created.members.push(data);
        return Promise.resolve({});
      }),
    },
    account: {
      create: vi.fn(
        ({ data }: { data: { provider: string; providerAccountId: string; userId: string } }) => {
          accounts.push(data);
          return Promise.resolve({});
        },
      ),
    },
    auditLog: {
      create: vi.fn(({ data }: { data: { action: string } }) => {
        created.audits.push(data);
        return Promise.resolve({});
      }),
    },
  };
  const prisma = {
    ...tx,
    account: {
      ...tx.account,
      findUnique: ({
        where,
      }: {
        where: { provider_providerAccountId: { provider: string; providerAccountId: string } };
      }) =>
        Promise.resolve(
          accounts.find(
            (a) =>
              a.provider === where.provider_providerAccountId.provider &&
              a.providerAccountId === where.provider_providerAccountId.providerAccountId,
          ) ?? null,
        ),
    },
    user: {
      ...tx.user,
      findFirst: ({ where }: { where: { email: string } }) => {
        const u = users.find((x) => x.email === where.email);
        return Promise.resolve(
          u === undefined
            ? null
            : { id: u.id, orgMemberships: u.orgs.map((organizationId) => ({ organizationId })) },
        );
      },
    },
  } as unknown as PrismaService;
  const signup = {
    createUser: vi.fn((_email: string, _proof: unknown, create: (t: unknown) => unknown) =>
      create(tx),
    ),
  };
  const config = { get: () => Buffer.alloc(32).toString('base64') } as unknown as ConfigService<
    AppEnv,
    true
  >;
  const service = new SsoService(
    prisma,
    config,
    signup as unknown as SignupPolicy,
    {} as GroupsService,
  );
  return { service, accounts, created, signup, tx };
}

const identity = (email: string | null, subject = 'sub-1') => ({ subject, email, name: 'Kim' });

describe('SsoService.resolve — which account an assertion becomes (§1.2)', () => {
  it('1. a known identity signs in as its user', async () => {
    const { service } = setup({
      accounts: [{ provider: 'sso:sso1', providerAccountId: 'sub-1', userId: 'u1' }],
    });
    expect(await service.resolve(conn(), identity(null))).toEqual({ userId: 'u1' });
  });

  it('2. links an existing user who belongs to this org and no other', async () => {
    const { service, accounts } = setup({
      users: [{ id: 'u1', email: 'kim@acme.com', orgs: [ORG] }],
    });
    expect(await service.resolve(conn(), identity('Kim@Acme.com'))).toEqual({ userId: 'u1' });
    expect(accounts).toContainEqual({
      userId: 'u1',
      provider: 'sso:sso1',
      providerAccountId: 'sub-1',
    });
  });

  it('2. never links a user of another org: no takeover across organisations', async () => {
    const { service, accounts, created } = setup({
      users: [{ id: 'u1', email: 'kim@acme.com', orgs: [OTHER] }],
    });
    expect(await service.resolve(conn(), identity('kim@acme.com'))).toEqual({
      refused: 'not_member',
    });
    expect(accounts).toEqual([]);
    expect(created.audits.map((a) => a.action)).toEqual(['auth.sso_refused']);
  });

  it('2. refuses to link a member who also belongs elsewhere', async () => {
    const { service, accounts } = setup({
      users: [{ id: 'u1', email: 'kim@acme.com', orgs: [ORG, OTHER] }],
    });
    expect(await service.resolve(conn(), identity('kim@acme.com'))).toEqual({
      refused: 'link_refused',
    });
    expect(accounts).toEqual([]);
  });

  it('3. JIT creates a verified member with the default role, through the sign-up policy', async () => {
    const { service, created, signup } = setup();
    const outcome = await service.resolve(
      conn({ jit: true, defaultOrgRole: 'guest' }),
      identity('new@acme.com'),
    );
    expect(outcome).toEqual({ userId: 'new_user' });
    expect(signup.createUser).toHaveBeenCalledWith(
      'new@acme.com',
      { emailProven: true, ssoOrgId: ORG },
      expect.any(Function),
    );
    expect(created.members).toEqual([{ organizationId: ORG, userId: 'new_user', role: 'guest' }]);
    expect(created.audits.map((a) => a.action)).toEqual(['org_member.added']);
  });

  it('3. JIT starts the new account on the org’s default appearance; linking an existing user does not', async () => {
    const orgSettings = {
      defaultAppearance: { theme: 'blueprint', variant: 'graphite', mode: 'dark' },
    };
    const jit = setup({ orgSettings });
    await jit.service.resolve(conn({ jit: true }), identity('new@acme.com'));
    expect(jit.tx.user.update).toHaveBeenCalledWith({
      where: { id: 'new_user' },
      data: { uiTheme: 'blueprint', uiVariant: 'graphite', theme: 'dark' },
    });

    const linked = setup({
      orgSettings,
      users: [{ id: 'u1', email: 'kim@acme.com', orgs: [ORG] }],
    });
    await linked.service.resolve(conn({ jit: true }), identity('kim@acme.com'));
    expect(linked.tx.user.update).not.toHaveBeenCalled();
  });

  it('3. JIT only for the connection’s domains', async () => {
    const { service, created } = setup();
    expect(await service.resolve(conn({ jit: true }), identity('kim@gmail.com'))).toEqual({
      refused: 'no_account',
    });
    expect(created.users).toEqual([]);
  });

  it('4. without JIT an unknown address is refused', async () => {
    const { service } = setup();
    expect(await service.resolve(conn(), identity('new@acme.com'))).toEqual({
      refused: 'no_account',
    });
  });

  it('an unverified or missing email only works for a known subject', async () => {
    const { service } = setup({ users: [{ id: 'u1', email: 'kim@acme.com', orgs: [ORG] }] });
    expect(await service.resolve(conn({ jit: true }), identity(null))).toEqual({
      refused: 'no_email',
    });
  });
});

describe('enforcedConnectionFor (§1.3)', () => {
  it('asks for an enforced connection of an org the user belongs to, owners excepted', async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: 'sso1', name: 'Acme Okta' });
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValue({ email: 'kim@acme.com' }) },
      ssoConnection: { findFirst },
    } as unknown as PrismaService;
    expect(await enforcedConnectionFor(prisma, 'u1')).toEqual({ id: 'sso1', name: 'Acme Okta' });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          enforced: true,
          domains: { has: 'acme.com' },
          organization: {
            deletedAt: null,
            members: { some: { userId: 'u1', role: { not: 'owner' } } },
          },
        },
      }),
    );
  });

  it('emailDomain is the lower-cased part after the last @', () => {
    expect(emailDomain('a@b@Sub.ACME.com')).toBe('sub.acme.com');
  });
});

describe('SsoService.syncClaimGroups — groups from a sign-in claim (roadmap 14b §2)', () => {
  function sync(mappings: { claimValue: string; groupId: string }[]) {
    const findMany = vi.fn().mockResolvedValue(mappings);
    const prisma = { ssoGroupMapping: { findMany } } as unknown as PrismaService;
    const groups = {
      addMemberByDirectory: vi.fn().mockResolvedValue(true),
      removeMemberByDirectory: vi.fn().mockResolvedValue(true),
    };
    const config = { get: () => '' } as unknown as ConfigService<AppEnv, true>;
    const service = new SsoService(
      prisma,
      config,
      {} as SignupPolicy,
      groups as unknown as GroupsService,
    );
    return { service, groups, findMany };
  }

  const MAPPINGS = [
    { claimValue: 'data-team', groupId: 'grp_data' },
    { claimValue: 'analysts', groupId: 'grp_data' },
    { claimValue: 'ops', groupId: 'grp_ops' },
  ];

  it('adds the user to mapped groups the claim lists and removes them from the rest', async () => {
    const { service, groups } = sync(MAPPINGS);
    await service.syncClaimGroups(conn({ groupsClaim: 'groups' }), 'u1', {
      ...identity('kim@acme.com'),
      groups: ['analysts', 'unmapped-team'],
    });
    // Either value of a group is enough.
    expect(groups.addMemberByDirectory).toHaveBeenCalledExactlyOnceWith(
      ORG,
      'grp_data',
      'u1',
      'sso',
    );
    expect(groups.removeMemberByDirectory).toHaveBeenCalledExactlyOnceWith(
      ORG,
      'grp_ops',
      'u1',
      'sso',
    );
  });

  it('never touches a group nobody mapped', async () => {
    const { service, groups } = sync([]);
    await service.syncClaimGroups(conn({ groupsClaim: 'groups' }), 'u1', {
      ...identity('kim@acme.com'),
      groups: ['data-team'],
    });
    expect(groups.addMemberByDirectory).not.toHaveBeenCalled();
    expect(groups.removeMemberByDirectory).not.toHaveBeenCalled();
  });

  it('an empty claim removes the user from every mapped group', async () => {
    const { service, groups } = sync(MAPPINGS);
    await service.syncClaimGroups(conn({ groupsClaim: 'groups' }), 'u1', {
      ...identity('kim@acme.com'),
      groups: [],
    });
    expect(groups.addMemberByDirectory).not.toHaveBeenCalled();
    expect(groups.removeMemberByDirectory).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the connection has no groups claim', async () => {
    const { service, groups, findMany } = sync(MAPPINGS);
    await service.syncClaimGroups(conn(), 'u1', identity('kim@acme.com'));
    expect(findMany).not.toHaveBeenCalled();
    expect(groups.addMemberByDirectory).not.toHaveBeenCalled();
  });

  it('groupsOf reads a list or a single value, and nothing when no claim is set', () => {
    expect(groupsOf({ groups: ['a', 2, 'b'] }, 'groups')).toEqual(['a', 'b']);
    expect(groupsOf({ memberOf: 'a' }, 'memberOf')).toEqual(['a']);
    expect(groupsOf({}, 'groups')).toEqual([]);
    expect(groupsOf({ groups: ['a'] }, null)).toBeUndefined();
  });
});
