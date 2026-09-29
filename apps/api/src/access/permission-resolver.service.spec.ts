import { BUILT_IN_ROLES, type OrgRole } from '@schemaloom/contracts';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { PERMISSION_MAP_TTL_CAP_SEC } from '../redis/ttl';
import { permMapKey, skeletonKey } from './cache-keys';
import { PermissionResolver } from './permission-resolver.service';
import type { Subject } from './types';

/**
 * Doc 05 §7.5 / §9 — the plumbing, with no live services. What is asserted here is what a
 * pure test cannot see: that R13 short-circuits BEFORE `access_grants` is read, that the
 * generation triple comes back in the SAME round trip as the project row and never from
 * Redis, that the TTL written is the remaining lifetime, and that a dead subject resolves
 * to a map nothing caches.
 */

const PROJECT = 'prj_shop';
const ORG = 'org_acme';
const ANA: Subject = { kind: 'user', userId: 'ana', orgId: ORG };
const NOW = 1_700_000_000_000;

interface GrantRowInput {
  id: string;
  resourceType: 'project' | 'area' | 'entity';
  resourceId: string;
  principalType: 'user' | 'group' | 'email_invite' | 'share_link';
  principalId: string;
  atoms: readonly string[];
  canUseAi?: boolean;
  canViewRestricted?: boolean;
  expiresAt?: Date | null;
}

const grantRow = (g: GrantRowInput) => ({
  id: g.id,
  resourceType: g.resourceType,
  resourceId: g.resourceId,
  principalType: g.principalType,
  principalId: g.principalId,
  canUseAi: g.canUseAi ?? false,
  canViewRestricted: g.canViewRestricted ?? false,
  expiresAt: g.expiresAt ?? null,
  role: { atoms: [...g.atoms] },
});

interface WorldOpts {
  projectRows?: unknown[];
  orgRole?: OrgRole | null;
  groupIds?: string[];
  grants?: ReturnType<typeof grantRow>[];
  shareLink?: { expiresAt: Date | null } | null;
  pg?: number;
}

function makeWorld(opts: WorldOpts = {}) {
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue(
      opts.projectRows ?? [
        {
          projectId: PROJECT,
          organizationId: ORG,
          restrictedFieldMode: 'mask',
          pg: opts.pg ?? 3,
          og: 1,
          sg: 2,
        },
      ],
    ),
    $transaction: vi.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    accessGrant: { findMany: vi.fn().mockResolvedValue(opts.grants ?? []) },
    shareLink: {
      findFirst: vi.fn().mockResolvedValue(opts.shareLink ?? null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    orgMember: {
      findUnique: vi
        .fn()
        .mockResolvedValue(
          opts.orgRole === null || opts.orgRole === undefined ? null : { role: opts.orgRole },
        ),
      findMany: vi.fn().mockResolvedValue([]),
    },
    groupMember: {
      findMany: vi.fn().mockResolvedValue((opts.groupIds ?? []).map((groupId) => ({ groupId }))),
    },
    entity: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'ent_inv', areaId: 'ar_bill' },
        { id: 'ent_emp', areaId: 'ar_bill' },
        { id: 'ent_aud', areaId: null },
      ]),
    },
    area: { findMany: vi.fn().mockResolvedValue([{ id: 'ar_bill' }]) },
    field: { findMany: vi.fn().mockResolvedValue([{ entityId: 'ent_emp' }]) },
  };

  const store = new Map<string, { value: string; ttl: number }>();
  const unlinked: string[] = [];
  const redis = {
    options: { keyPrefix: 'sl:cache:' },
    get: vi.fn((key: string) => Promise.resolve(store.get(key)?.value ?? null)),
    set: vi.fn((key: string, value: string, _ex: string, ttl: number) => {
      store.set(key, { value, ttl });
      return Promise.resolve('OK');
    }),
    del: vi.fn((key: string) => {
      store.delete(key);
      return Promise.resolve(1);
    }),
    scan: vi.fn((_cursor: string, _match: string, _pattern: string, _count: string, _n: number) =>
      Promise.resolve(['0', [...store.keys()].map((k) => `sl:cache:${k}`)]),
    ),
    unlink: vi.fn((...keys: string[]) => {
      unlinked.push(...keys);
      for (const k of keys) store.delete(k);
      return Promise.resolve(keys.length);
    }),
  };

  const resolver = new PermissionResolver(
    prisma as unknown as PrismaService,
    redis as unknown as Redis,
  );
  return { prisma, redis, store, unlinked, resolver };
}

beforeEach(() => {
  vi.setSystemTime(new Date(NOW));
});

describe('§9.1 — the project row and all three generations in ONE round trip', () => {
  it('reads them from Postgres, not from Redis, and keys the cache by them', async () => {
    const w = makeWorld({ orgRole: 'member' });
    await w.resolver.resolveProject(ANA, PROJECT);

    expect(w.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = String(w.prisma.$queryRaw.mock.calls[0]?.[0]);
    expect(sql).toContain('perm_generation');
    expect(sql).toContain('deleted_at IS NULL');
    // There is no `gen:` mirror to read — the write-back race it created is why.
    for (const call of w.redis.get.mock.calls) expect(call[0]).not.toContain('gen:');
    expect([...w.store.keys()]).toContain(permMapKey(PROJECT, 'u:ana', { og: 1, pg: 3, sg: 2 }));
  });

  it('a bumped generation misses the old entry instead of reusing it', async () => {
    const before = makeWorld({ orgRole: 'member' });
    await before.resolver.resolveProject(ANA, PROJECT);
    const oldKey = [...before.store.keys()].find((k) => k.startsWith('perm:'));

    const after = makeWorld({ orgRole: 'member', pg: 4 });
    await after.resolver.resolveProject(ANA, PROJECT);
    const newKey = [...after.store.keys()].find((k) => k.startsWith('perm:'));

    expect(oldKey).toBeDefined();
    expect(newKey).not.toBe(oldKey);
  });

  it('batches many projects into that same single query', async () => {
    const w = makeWorld({
      orgRole: 'member',
      projectRows: ['p1', 'p2', 'p3'].map((id) => ({
        projectId: id,
        organizationId: ORG,
        restrictedFieldMode: 'mask',
        pg: 1,
        og: 1,
        sg: 1,
      })),
    });
    const maps = await w.resolver.resolveProjects(ANA, ['p1', 'p2', 'p3']);
    expect(maps.size).toBe(3);
    expect(w.prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('returns an EMPTY_MAP for a project with no row, and caches nothing for it', async () => {
    const w = makeWorld({ projectRows: [] });
    const map = await w.resolver.resolveProject(ANA, PROJECT);
    expect(w.resolver.canOpenProject(map)).toBe(false);
    expect(map.validUntil).toBe(0);
    expect(w.redis.set).not.toHaveBeenCalled();
  });
});

describe('R13 — the short-circuit is inescapable, and grants are not even read', () => {
  it('owner gets all nine without one grants query', async () => {
    const w = makeWorld({ orgRole: 'owner', grants: [] });
    const map = await w.resolver.resolveProject(ANA, PROJECT);

    expect(w.prisma.accessGrant.findMany).not.toHaveBeenCalled();
    expect(map.projectAtoms.size).toBe(9);
    const skel = await w.resolver.skeleton(PROJECT);
    expect(w.resolver.atomsAt(map, skel, { type: 'entity', id: 'ent_emp' }).size).toBe(9);
    // Step 1 ran before step 2: the areas are populated, so VisibilityFilter will not
    // redact the whole schema away from an owner.
    expect(map.areaAtoms.get('ar_bill')?.size).toBe(9);
  });

  it('a narrowing grant on an owner never reaches the resolver at all', async () => {
    const w = makeWorld({
      orgRole: 'owner',
      grants: [
        grantRow({
          id: 'g1',
          resourceType: 'entity',
          resourceId: 'ent_emp',
          principalType: 'user',
          principalId: 'ana',
          atoms: [...BUILT_IN_ROLES.viewer],
        }),
      ],
    });
    const map = await w.resolver.resolveProject(ANA, PROJECT);
    const skel = await w.resolver.skeleton(PROJECT);
    expect(w.resolver.atomsAt(map, skel, { type: 'entity', id: 'ent_emp' }).size).toBe(9);
    expect(w.prisma.accessGrant.findMany).not.toHaveBeenCalled();
  });

  // Product decision 2026-09-29: R13 is OWNER-only. An admin manages the org but sees only
  // the projects, areas and entities they are granted, exactly like a member.
  it('an admin with no grant cannot open the project', async () => {
    const w = makeWorld({ orgRole: 'admin', grants: [] });
    const map = await w.resolver.resolveProject(ANA, PROJECT);
    expect(w.resolver.canOpenProject(map)).toBe(false);
  });

  it("an admin's grant is resolved like anyone else's, narrowing included", async () => {
    const w = makeWorld({
      orgRole: 'admin',
      grants: [
        grantRow({
          id: 'g1',
          resourceType: 'entity',
          resourceId: 'ent_emp',
          principalType: 'user',
          principalId: 'ana',
          atoms: [...BUILT_IN_ROLES.viewer],
        }),
      ],
    });
    const map = await w.resolver.resolveProject(ANA, PROJECT);
    const skel = await w.resolver.skeleton(PROJECT);
    expect([...w.resolver.atomsAt(map, skel, { type: 'entity', id: 'ent_emp' })].sort()).toEqual(
      [...BUILT_IN_ROLES.viewer].sort(),
    );
    expect(map.projectAtoms.size).toBe(0);
  });

  it('E7/R12.2: a user who is not an OrgMember gets EMPTY_MAP, grants unread', async () => {
    const w = makeWorld({ orgRole: null });
    const map = await w.resolver.resolveProject(ANA, PROJECT);
    expect(w.resolver.canOpenProject(map)).toBe(false);
    expect(w.prisma.accessGrant.findMany).not.toHaveBeenCalled();
    // The subject-independent skeleton is still cached; the EMPTY_MAP is not, because
    // there is no subject state to key it by.
    expect([...w.store.keys()].filter((k) => k.startsWith('perm:'))).toEqual([]);
  });
});

describe('the hot query — R12.1 and the principal set', () => {
  it('asks for the subject AND every group, with expiry as a SQL predicate', async () => {
    const w = makeWorld({ orgRole: 'member', groupIds: ['grp_analysts', 'grp_contractors'] });
    await w.resolver.resolveProject(ANA, PROJECT);

    const where = w.prisma.accessGrant.findMany.mock.calls[0]?.[0] as {
      where: {
        projectId: string;
        OR: { principalType: string; principalId: string }[];
        AND: { OR: { expiresAt?: unknown }[] };
      };
    };
    expect(where.where.projectId).toBe(PROJECT);
    expect(where.where.OR).toEqual([
      { principalType: 'user', principalId: 'ana' },
      { principalType: 'group', principalId: 'grp_analysts' },
      { principalType: 'group', principalId: 'grp_contractors' },
    ]);
    // Expiry is evaluated in SQL at resolve time, never by a cron that can run late.
    expect(where.where.AND.OR).toEqual([{ expiresAt: null }, { expiresAt: { gt: new Date(NOW) } }]);
  });

  it('R11: an email_invite row that somehow matched grants nothing', async () => {
    const w = makeWorld({
      orgRole: 'member',
      grants: [
        grantRow({
          id: 'g1',
          resourceType: 'project',
          resourceId: PROJECT,
          principalType: 'email_invite',
          principalId: 'ana@example.com',
          atoms: [...BUILT_IN_ROLES.manager],
        }),
      ],
    });
    const map = await w.resolver.resolveProject(ANA, PROJECT);
    expect(w.resolver.canOpenProject(map)).toBe(false);
  });

  it('resolves a real project grant to that role', async () => {
    const w = makeWorld({
      orgRole: 'member',
      grants: [
        grantRow({
          id: 'g1',
          resourceType: 'project',
          resourceId: PROJECT,
          principalType: 'user',
          principalId: 'ana',
          atoms: [...BUILT_IN_ROLES.editor],
        }),
      ],
    });
    const map = await w.resolver.resolveProject(ANA, PROJECT);
    expect([...map.projectAtoms].sort()).toEqual([...BUILT_IN_ROLES.editor].sort());
    expect(map.entityOverrides.size).toBe(0);
  });
});

describe('§7.12 — share-link subjects', () => {
  const LINK: Subject = { kind: 'share_link', shareLinkId: 'sl_1', projectId: PROJECT };

  it('R17: a link carrying manager + canUseAi still resolves to schema:view only', async () => {
    const w = makeWorld({
      shareLink: { expiresAt: null },
      grants: [
        grantRow({
          id: 'g1',
          resourceType: 'project',
          resourceId: PROJECT,
          principalType: 'share_link',
          principalId: 'sl_1',
          atoms: [...BUILT_IN_ROLES.manager],
          canUseAi: true,
          canViewRestricted: true,
        }),
      ],
    });
    const map = await w.resolver.resolveProject(LINK, PROJECT);
    expect([...map.projectAtoms]).toEqual(['schema:view']);
    expect(map.orgRole).toBeNull();
    expect(w.prisma.orgMember.findUnique).not.toHaveBeenCalled();
  });

  it('a revoked or expired link resolves to EMPTY_MAP and reads no grants', async () => {
    const w = makeWorld({ shareLink: null });
    const map = await w.resolver.resolveProject(LINK, PROJECT);
    expect(w.resolver.canOpenProject(map)).toBe(false);
    expect(w.prisma.accessGrant.findMany).not.toHaveBeenCalled();
  });

  it('a session for another project can never address this one', async () => {
    const w = makeWorld({ shareLink: { expiresAt: null } });
    const other: Subject = { kind: 'share_link', shareLinkId: 'sl_1', projectId: 'prj_other' };
    const map = await w.resolver.resolveProject(other, PROJECT);
    expect(w.resolver.canOpenProject(map)).toBe(false);
    expect(w.prisma.shareLink.findFirst).not.toHaveBeenCalled();
  });

  it('a link expiring in 30 s is cached for 30 s, not 300', async () => {
    const w = makeWorld({
      shareLink: { expiresAt: new Date(NOW + 30_000) },
      grants: [
        grantRow({
          id: 'g1',
          resourceType: 'project',
          resourceId: PROJECT,
          principalType: 'share_link',
          principalId: 'sl_1',
          atoms: [...BUILT_IN_ROLES.viewer],
        }),
      ],
    });
    await w.resolver.resolveProject(LINK, PROJECT);
    const entry = [...w.store.entries()].find(([k]) => k.startsWith('perm:'));
    expect(entry?.[1].ttl).toBe(30);
  });

  it('sg is 0 for a link subject: no user id is bound into the generation query', async () => {
    const w = makeWorld({ shareLink: { expiresAt: null } });
    await w.resolver.resolveProject(LINK, PROJECT);
    expect(w.prisma.$queryRaw.mock.calls[0]?.slice(1)).toContain(null);
  });
});

describe('§9.1 — caching behaviour', () => {
  it('writes the map with the capped TTL and serves the second call from Redis', async () => {
    const w = makeWorld({ orgRole: 'member' });
    await w.resolver.resolveProject(ANA, PROJECT);
    const entry = [...w.store.entries()].find(([k]) => k.startsWith('perm:'));
    expect(entry?.[1].ttl).toBe(PERMISSION_MAP_TTL_CAP_SEC);

    w.prisma.accessGrant.findMany.mockClear();
    const again = await w.resolver.resolveProject(ANA, PROJECT);
    expect(w.prisma.accessGrant.findMany).not.toHaveBeenCalled();
    expect([...again.projectAtoms]).toEqual([]);
  });

  it('every key it writes carries a positive TTL — nothing is SET without one', async () => {
    const w = makeWorld({ orgRole: 'member' });
    await w.resolver.resolveProject(ANA, PROJECT);
    expect(w.redis.set.mock.calls.length).toBeGreaterThan(0);
    for (const call of w.redis.set.mock.calls) {
      expect(call[2]).toBe('EX');
      expect(call[3]).toBeGreaterThan(0);
    }
  });

  it('caches the skeleton for 600 s under the project generation alone', async () => {
    const w = makeWorld({ orgRole: 'member' });
    await w.resolver.resolveProject(ANA, PROJECT);
    const entry = w.store.get(skeletonKey(PROJECT, 3));
    expect(entry?.ttl).toBe(600);

    w.prisma.entity.findMany.mockClear();
    await w.resolver.skeleton(PROJECT);
    expect(w.prisma.entity.findMany).not.toHaveBeenCalled();
  });

  it('drops a cached map whose own validUntil has passed, rather than serving it', async () => {
    const w = makeWorld({ orgRole: 'member' });
    await w.resolver.resolveProject(ANA, PROJECT);
    const key = [...w.store.keys()].find((k) => k.startsWith('perm:'));
    expect(key).toBeDefined();

    vi.setSystemTime(new Date(NOW + PERMISSION_MAP_TTL_CAP_SEC * 1000 + 1));
    w.prisma.accessGrant.findMany.mockClear();
    await w.resolver.resolveProject(ANA, PROJECT);
    expect(w.redis.del).toHaveBeenCalled();
    expect(w.prisma.accessGrant.findMany).toHaveBeenCalled();
  });

  it('a Redis outage degrades to a recompute, never to a denial', async () => {
    const w = makeWorld({
      orgRole: 'member',
      grants: [
        grantRow({
          id: 'g1',
          resourceType: 'project',
          resourceId: PROJECT,
          principalType: 'user',
          principalId: 'ana',
          atoms: [...BUILT_IN_ROLES.manager],
        }),
      ],
    });
    w.redis.get.mockRejectedValue(new Error('ECONNREFUSED'));
    w.redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    const map = await w.resolver.resolveProject(ANA, PROJECT);
    expect(map.projectAtoms.has('sharing:manage')).toBe(true);
  });

  it('resolveProjectUncached bypasses Redis in both directions (§7.14)', async () => {
    const w = makeWorld({ orgRole: 'member' });
    await w.resolver.resolveProjectUncached(ANA, PROJECT);
    expect(w.redis.get).not.toHaveBeenCalled();
    expect(w.redis.set).not.toHaveBeenCalled();
    expect(w.prisma.accessGrant.findMany).toHaveBeenCalled();
  });

  it('de-duplicates concurrent resolves of the same key into one compute', async () => {
    const w = makeWorld({ orgRole: 'member' });
    await Promise.all([
      w.resolver.resolveProject(ANA, PROJECT),
      w.resolver.resolveProject(ANA, PROJECT),
      w.resolver.resolveProject(ANA, PROJECT),
    ]);
    expect(w.prisma.accessGrant.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('R23 / §7.7 — resolveResource, the inverse direction', () => {
  const ENT: { type: 'entity'; id: string } = { type: 'entity', id: 'ent_emp' };

  function inverseWorld() {
    const w = makeWorld({
      orgRole: 'member',
      grants: [
        grantRow({
          id: 'g1',
          resourceType: 'project',
          resourceId: PROJECT,
          principalType: 'user',
          principalId: 'ana',
          atoms: [...BUILT_IN_ROLES.manager],
        }),
        grantRow({
          id: 'g2',
          resourceType: 'entity',
          resourceId: 'ent_emp',
          principalType: 'group',
          principalId: 'grp_analysts',
          atoms: [...BUILT_IN_ROLES.viewer],
        }),
        grantRow({
          id: 'g3',
          resourceType: 'entity',
          resourceId: 'ent_emp',
          principalType: 'share_link',
          principalId: 'sl_1',
          atoms: [...BUILT_IN_ROLES.manager],
        }),
      ],
    });
    w.prisma.groupMember.findMany.mockResolvedValue([
      { groupId: 'grp_analysts', userId: 'bob' },
      { groupId: 'grp_analysts', userId: 'ghost' },
    ]);
    w.prisma.orgMember.findMany.mockResolvedValue([
      { userId: 'ana', role: 'member' },
      { userId: 'bob', role: 'guest' },
      { userId: 'zoe', role: 'owner' },
      { userId: 'adam', role: 'admin' },
    ]);
    w.prisma.shareLink.findMany.mockResolvedValue([{ id: 'sl_1', expiresAt: null }]);
    return w;
  }

  it('lists PEOPLE: groups expanded, org owners folded in, ceilings applied', async () => {
    const w = inverseWorld();
    const who = await w.resolver.resolveResource(PROJECT, ENT);

    // R15: ana's nearest level is the project, so she is a manager here.
    expect([...(who.get('user:ana') ?? [])].sort()).toEqual([...BUILT_IN_ROLES.manager].sort());
    // A guest reached through a group keeps viewer; R13 makes the OWNER all nine. An admin
    // with no grant here is not in the list at all.
    expect([...(who.get('user:bob') ?? [])].sort()).toEqual([...BUILT_IN_ROLES.viewer].sort());
    expect(who.get('user:zoe')?.size).toBe(9);
    expect(who.has('user:adam')).toBe(false);
    // R17: the link's grant says manager; the ceiling says otherwise.
    expect([...(who.get('share_link:sl_1') ?? [])]).toEqual(['schema:view']);
    // R12.2: a group member who is not an OrgMember of this org is not live.
    expect(who.has('user:ghost')).toBe(false);
  });

  it('P13: it agrees with atomsAt(resolveProject(subject), ref)', async () => {
    const w = inverseWorld();
    const who = await w.resolver.resolveResource(PROJECT, ENT);
    const map = await w.resolver.resolveProject(ANA, PROJECT);
    const skel = await w.resolver.skeleton(PROJECT);
    expect([...w.resolver.atomsAt(map, skel, ENT)].sort()).toEqual(
      [...(who.get('user:ana') ?? [])].sort(),
    );
  });

  it('returns nothing for a resource that is not in the project', async () => {
    const w = inverseWorld();
    expect((await w.resolver.resolveResource(PROJECT, { type: 'entity', id: 'nope' })).size).toBe(
      0,
    );
    expect((await w.resolver.resolveResource(PROJECT, { type: 'area', id: 'nope' })).size).toBe(0);
  });

  it('drops a revoked share link rather than listing it', async () => {
    const w = inverseWorld();
    w.prisma.shareLink.findMany.mockResolvedValue([]);
    const who = await w.resolver.resolveResource(PROJECT, ENT);
    expect(who.has('share_link:sl_1')).toBe(false);
  });
});

describe('§9.3 — invalidate', () => {
  it('unlinks the project map and skeleton keys, un-prefixed', async () => {
    const w = makeWorld({ orgRole: 'member' });
    await w.resolver.resolveProject(ANA, PROJECT);
    await w.resolver.invalidate({ project: PROJECT });

    expect(w.redis.scan).toHaveBeenCalled();
    expect(w.redis.scan.mock.calls[0]?.[2]).toBe(`sl:cache:perm:4:${PROJECT}:*`);
    for (const key of w.unlinked) expect(key.startsWith('sl:cache:')).toBe(false);
  });

  it('targets the org-membership keys for an org or user bump', async () => {
    const w = makeWorld({ orgRole: 'member' });
    await w.resolver.invalidate({ org: ORG, user: 'ana' });
    const patterns = w.redis.scan.mock.calls.map((c) => c[2]);
    expect(patterns).toContain(`sl:cache:orgmem:4:${ORG}:*`);
    expect(patterns).toContain('sl:cache:orgmem:4:*:ana:*');
  });

  it('survives a Redis failure: eviction is memory, not correctness', async () => {
    const w = makeWorld({ orgRole: 'member' });
    w.redis.scan.mockRejectedValue(new Error('down'));
    await expect(w.resolver.invalidate({ project: PROJECT })).resolves.toBeUndefined();
  });
});
