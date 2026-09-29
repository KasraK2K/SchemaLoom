import { BUILT_IN_ROLES } from '@schemaloom/contracts';
import { describe, expect, it } from 'vitest';
import {
  PERMISSION_MAP_TTL_CAP_SEC,
  PERMISSION_SKELETON_TTL_SEC,
  cappedTtlSec,
} from '../redis/ttl';
import {
  buildSkeleton,
  orgMemberKey,
  parseMap,
  parseSkeleton,
  permMapKey,
  serializeMap,
  serializeSkeleton,
  skeletonKey,
  type Generations,
} from './cache-keys';
import type { ProjectPermissionMap } from './types';

const GEN: Generations = { og: 4, pg: 11, sg: 2 };

const MAP: ProjectPermissionMap = {
  projectId: 'prj_shop',
  subjectKey: 'u:ana',
  orgRole: 'member',
  projectAtoms: BUILT_IN_ROLES.editor,
  areaAtoms: new Map([
    ['ar_bill', BUILT_IN_ROLES.viewer],
    ['ar_cat', BUILT_IN_ROLES.editor],
  ]),
  entityOverrides: new Map([['ent_emp', BUILT_IN_ROLES.commenter]]),
  restrictedFieldMode: 'hide',
  validUntil: 1_700_000_300_000,
};

describe('§9.1 key shapes', () => {
  it('spells the permission map key `perm:4:{project}:{subject}:{og}.{pg}.{sg}`', () => {
    expect(permMapKey('prj_shop', 'u:ana', GEN)).toBe('perm:4:prj_shop:u:ana:4.11.2');
    expect(permMapKey('prj_shop', 'sl:link1', GEN)).toBe('perm:4:prj_shop:sl:link1:4.11.2');
  });

  it('keys the skeleton by the PROJECT generation alone — it is subject-independent', () => {
    expect(skeletonKey('prj_shop', 11)).toBe('skel:4:prj_shop:11');
  });

  it('keys org membership by `{og}.{sg}`, with no project in it', () => {
    expect(orgMemberKey('org_acme', 'ana', GEN)).toBe('orgmem:4:org_acme:ana:4.2');
  });

  it('carries NO REDIS_KEY_PREFIX: ioredis prepends `${prefix}cache:` itself', () => {
    for (const key of [
      permMapKey('p', 's', GEN),
      skeletonKey('p', 1),
      orgMemberKey('o', 'u', GEN),
    ]) {
      expect(key.startsWith('sl:')).toBe(false);
      expect(key.startsWith('cache:')).toBe(false);
    }
  });

  it('changes when ANY generation moves — which is what makes a revoke instant', () => {
    const base = permMapKey('p', 'u:ana', GEN);
    expect(permMapKey('p', 'u:ana', { ...GEN, og: 5 })).not.toBe(base);
    expect(permMapKey('p', 'u:ana', { ...GEN, pg: 12 })).not.toBe(base);
    expect(permMapKey('p', 'u:ana', { ...GEN, sg: 3 })).not.toBe(base);
  });
});

describe('serialisation round-trips every field', () => {
  it('restores the map exactly', () => {
    const back = parseMap(serializeMap(MAP));
    expect(back).not.toBeNull();
    expect(back?.projectId).toBe('prj_shop');
    expect(back?.orgRole).toBe('member');
    expect(back?.restrictedFieldMode).toBe('hide');
    expect(back?.validUntil).toBe(MAP.validUntil);
    expect([...(back?.projectAtoms ?? [])].sort()).toEqual([...BUILT_IN_ROLES.editor].sort());
    expect([...(back?.areaAtoms.get('ar_bill') ?? [])].sort()).toEqual(
      [...BUILT_IN_ROLES.viewer].sort(),
    );
    expect([...(back?.entityOverrides.keys() ?? [])]).toEqual(['ent_emp']);
  });

  it('restores a share-link map, whose orgRole is null', () => {
    const back = parseMap(serializeMap({ ...MAP, orgRole: null, subjectKey: 'sl:l1' }));
    expect(back?.orgRole).toBeNull();
  });

  it('restores the skeleton, entityById included', () => {
    const skel = buildSkeleton(
      9,
      ['ar_bill'],
      [
        { id: 'ent_inv', areaId: 'ar_bill' },
        { id: 'ent_aud', areaId: null },
      ],
      ['ent_inv'],
    );
    const back = parseSkeleton(serializeSkeleton(skel));
    expect(back?.generation).toBe(9);
    expect(back?.entityById.get('ent_aud')?.areaId).toBeNull();
    expect(back?.entitiesWithRestrictedFields.has('ent_inv')).toBe(true);
    expect(back?.areaIds).toEqual(['ar_bill']);
  });
});

describe('a corrupt entry degrades to a cache MISS, never to a wrong map', () => {
  it.each([
    ['not json', 'definitely not json'],
    ['an array', '[]'],
    ['a missing field', '{"projectId":"p"}'],
    ['a bad orgRole', serializeMap(MAP).replace('"member"', '"superuser"')],
    ['a bad mode', serializeMap(MAP).replace('"hide"', '"invisible"')],
    ['a non-numeric validUntil', serializeMap(MAP).replace(String(MAP.validUntil), '"soon"')],
    [
      'a malformed area entry',
      '{"projectId":"p","subjectKey":"u:a","orgRole":null,"projectAtoms":[],"areaAtoms":[["x"]],"entityOverrides":[],"restrictedFieldMode":"mask","validUntil":1}',
    ],
  ])('rejects %s', (_label, raw) => {
    expect(parseMap(raw)).toBeNull();
  });

  it('drops an unknown atom string rather than carrying it into the map', () => {
    const raw = serializeMap(MAP).replace('"schema:view"', '"billing:god-mode"');
    const back = parseMap(raw);
    expect(back).not.toBeNull();
    expect([...(back?.projectAtoms ?? [])]).not.toContain('billing:god-mode');
  });

  it.each([
    ['not json', '{'],
    ['a missing generation', '{"areaIds":[],"entities":[],"entitiesWithRestrictedFields":[]}'],
    [
      'a malformed entity pair',
      '{"generation":1,"areaIds":[],"entities":[["a"]],"entitiesWithRestrictedFields":[]}',
    ],
  ])('rejects a skeleton that is %s', (_label, raw) => {
    expect(parseSkeleton(raw)).toBeNull();
  });
});

describe('the TTL is REMAINING SECONDS, not an absolute timestamp', () => {
  const now = new Date(1_700_000_000_000);

  it('caps at 300 s when the map outlives the cap', () => {
    const validUntil = new Date(now.getTime() + 10 * 60 * 1000);
    expect(cappedTtlSec(validUntil, now)).toBe(PERMISSION_MAP_TTL_CAP_SEC);
  });

  it('is the REMAINDER when the map expires sooner — the §7.12 30-second link', () => {
    expect(cappedTtlSec(new Date(now.getTime() + 30_000), now)).toBe(30);
    expect(cappedTtlSec(new Date(now.getTime() + 1_000), now)).toBe(1);
  });

  it('is never negative and never zero: an expired map is not cached at all', () => {
    expect(cappedTtlSec(new Date(now.getTime() - 1), now)).toBeNull();
    expect(cappedTtlSec(new Date(now.getTime() - 86_400_000), now)).toBeNull();
    expect(cappedTtlSec(now, now)).toBeNull();
  });

  it('is NOT min(300, validUntil) — that comparison always picks 300', () => {
    const validUntil = new Date(now.getTime() + 30_000);
    expect(cappedTtlSec(validUntil, now)).not.toBe(PERMISSION_MAP_TTL_CAP_SEC);
    expect(Math.min(PERMISSION_MAP_TTL_CAP_SEC, validUntil.getTime())).toBe(
      PERMISSION_MAP_TTL_CAP_SEC,
    );
  });

  it('gives the skeleton its own 600 s cap', () => {
    expect(PERMISSION_SKELETON_TTL_SEC).toBe(600);
    expect(cappedTtlSec(null, now, PERMISSION_SKELETON_TTL_SEC)).toBe(600);
  });
});
