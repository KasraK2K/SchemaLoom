import {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_ORDER,
  type BuiltInResourceRole,
  type OrgRole,
  type RestrictedFieldMode,
} from '@schemaloom/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildSkeleton } from './cache-keys';
import { atomsAt, canOpenProject, computeProjectMap } from './resolve';
import {
  principalKey,
  type LiveGrant,
  type PrincipalKey,
  type ProjectPermissionMap,
  type ProjectSkeleton,
  type ResourceRef,
  type SkeletonEntity,
  type Subject,
} from './types';

/**
 * Doc 05 §11.3 — the property-based half of the permission suite.
 *
 * These are the invariants that the golden matrix cannot state. The matrix pins 2,220
 * specific answers; these pin the SHAPE of every answer the resolver can ever give, over
 * randomly generated worlds. Between them they are why the permission cache is sound:
 * R16 and R18 are what make "resolve once, reuse for 300 s" not a security bug.
 *
 * Everything here runs against the real `computeProjectMap` / `atomsAt`. No database.
 */

const PROJECT = 'prj_1';
const NOW = 1_700_000_000_000;
const AREA_POOL = ['ar_a', 'ar_b', 'ar_c'] as const;
const PRINCIPALS = {
  self: principalKey('user', 'usr_ana'),
  groupA: principalKey('group', 'grp_a'),
  groupB: principalKey('group', 'grp_b'),
} as const;

const USER: Subject = { kind: 'user', userId: 'usr_ana', orgId: 'org_1' };
const LINK: Subject = { kind: 'share_link', shareLinkId: 'sl_1', projectId: PROJECT };

interface GrantSpec {
  readonly principal: PrincipalKey;
  readonly ref: ResourceRef;
  readonly role: BuiltInResourceRole;
  readonly canUseAi: boolean;
  readonly canViewRestricted: boolean;
}

interface World {
  readonly areaIds: readonly string[];
  readonly entities: readonly SkeletonEntity[];
}

// ---------------------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------------------

const worldArb: fc.Arbitrary<World> = fc
  .record({
    areaIds: fc.shuffledSubarray([...AREA_POOL], { minLength: 0, maxLength: 3 }),
    entityCount: fc.integer({ min: 1, max: 6 }),
  })
  .chain(({ areaIds, entityCount }) =>
    fc
      .array(fc.constantFrom<string | null>(...areaIds, null), {
        minLength: entityCount,
        maxLength: entityCount,
      })
      .map((areaOf) => ({
        areaIds,
        entities: areaOf.map((areaId, i) => ({ id: `ent_${String(i)}`, areaId })),
      })),
  );

function refArb(world: World): fc.Arbitrary<ResourceRef> {
  return fc.constantFrom<ResourceRef>(
    { type: 'project', id: PROJECT },
    ...world.areaIds.map((id): ResourceRef => ({ type: 'area', id })),
    ...world.entities.map((e): ResourceRef => ({ type: 'entity', id: e.id })),
  );
}

function grantsArb(
  world: World,
  principals: readonly PrincipalKey[],
  max = 5,
): fc.Arbitrary<GrantSpec[]> {
  return fc.array(
    fc.record({
      principal: fc.constantFrom(...principals),
      ref: refArb(world),
      role: fc.constantFrom(...BUILT_IN_ROLE_ORDER),
      canUseAi: fc.boolean(),
      canViewRestricted: fc.boolean(),
    }),
    { minLength: 0, maxLength: max },
  );
}

const skeletonOf = (world: World): ProjectSkeleton =>
  buildSkeleton(1, world.areaIds, world.entities, []);

function liveGrants(specs: readonly GrantSpec[]): LiveGrant[] {
  return specs.map((spec, i) => ({
    id: `gr_${String(i)}`,
    resourceType: spec.ref.type,
    resourceId: spec.ref.id,
    principalKey: spec.principal,
    atoms: [...BUILT_IN_ROLES[spec.role]],
    canUseAi: spec.canUseAi,
    canViewRestricted: spec.canViewRestricted,
    expiresAt: null,
    linkExpiresAt: null,
  }));
}

function resolveWith(
  world: World,
  principals: readonly PrincipalKey[],
  grants: readonly GrantSpec[],
  over: { subject?: Subject; orgRole?: OrgRole | null; mode?: RestrictedFieldMode } = {},
): ProjectPermissionMap {
  return computeProjectMap({
    projectId: PROJECT,
    subject: over.subject ?? USER,
    orgRole: over.orgRole === undefined ? 'member' : over.orgRole,
    principals,
    grants: liveGrants(grants),
    skeleton: skeletonOf(world),
    restrictedFieldMode: over.mode ?? 'mask',
    nowMs: NOW,
  });
}

/** Every resource in the world, which is every cell an invariant has to hold at. */
function allRefs(world: World): ResourceRef[] {
  return [
    { type: 'project', id: PROJECT },
    ...world.areaIds.map((id): ResourceRef => ({ type: 'area', id })),
    ...world.entities.map((e): ResourceRef => ({ type: 'entity', id: e.id })),
  ];
}

/** A total, order-free rendering of a map, so two maps compare as strings. */
function snapshot(world: World, map: ProjectPermissionMap): string {
  const skel = skeletonOf(world);
  const cells = allRefs(world).map((ref) => {
    const atoms = [...atomsAt(map, skel, ref)].sort().join('+');
    return `${ref.type}:${ref.id}=${atoms}`;
  });
  return `${cells.join('|')}|open=${String(canOpenProject(map))}`;
}

// ---------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------

describe('P1 — a guest with no live grant holds nothing, anywhere', () => {
  it('yields an empty set at every resource and cannot open the project', () => {
    fc.assert(
      fc.property(worldArb, (world) => {
        const map = resolveWith(world, [PRINCIPALS.self], [], { orgRole: 'guest' });
        const skel = skeletonOf(world);
        for (const ref of allRefs(world)) {
          expect([...atomsAt(map, skel, ref)]).toEqual([]);
        }
        expect(canOpenProject(map)).toBe(false);
      }),
    );
  });
});

describe('R16 — monotonicity: the invariant the permission cache rests on', () => {
  /**
   * P5, exactly as §11.3 states it: monotone IN PRINCIPALS. Step 5 unions across
   * principals, so a group's narrow grant can never demote a broader personal one (E5).
   * This is the "my group grant demoted me" bug, and it is also what makes a cached map
   * safe to hand back after a group membership was ADDED.
   */
  it('adding a principal never removes an atom at any resource', () => {
    fc.assert(
      fc.property(
        worldArb.chain((world) =>
          fc.record({
            world: fc.constant(world),
            own: grantsArb(world, [PRINCIPALS.self]),
            theirs: grantsArb(world, [PRINCIPALS.groupA]),
          }),
        ),
        ({ world, own, theirs }) => {
          const skel = skeletonOf(world);
          const before = resolveWith(world, [PRINCIPALS.self], own);
          const after = resolveWith(
            world,
            [PRINCIPALS.self, PRINCIPALS.groupA],
            [...own, ...theirs],
          );
          for (const ref of allRefs(world)) {
            for (const atom of atomsAt(before, skel, ref)) {
              expect(
                atomsAt(after, skel, ref).has(atom),
                `${ref.type}:${ref.id} lost ${atom}`,
              ).toBe(true);
            }
          }
        },
      ),
    );
  });

  /**
   * The second half, and the boundary of the claim. `indexGrants` UNIONS two grants at
   * the same (principal, level), so widening there is monotone too.
   *
   * It is deliberately NOT asserted for a grant at a NEARER level, because there the
   * invariant is false BY DESIGN: R15 is nearest-level-wins per principal, so giving
   * `usr_ana` Viewer on one entity while she holds Editor on the project REMOVES
   * `schema:edit` at that entity. That is E1, it is the intended rule, and a property
   * test asserting "adding any grant never removes access" would be asserting a bug.
   */
  it('adding a grant at a level a principal already holds never removes an atom', () => {
    fc.assert(
      fc.property(
        worldArb.chain((world) =>
          fc.record({
            world: fc.constant(world),
            base: grantsArb(world, [PRINCIPALS.self], 4),
            role: fc.constantFrom(...BUILT_IN_ROLE_ORDER),
          }),
        ),
        ({ world, base, role }) => {
          const skel = skeletonOf(world);
          const widened = [
            ...base,
            ...base.map((g) => ({ ...g, role, canUseAi: true, canViewRestricted: true })),
          ];
          const before = resolveWith(world, [PRINCIPALS.self], base);
          const after = resolveWith(world, [PRINCIPALS.self], widened);
          for (const ref of allRefs(world)) {
            for (const atom of atomsAt(before, skel, ref)) {
              expect(
                atomsAt(after, skel, ref).has(atom),
                `${ref.type}:${ref.id} lost ${atom}`,
              ).toBe(true);
            }
          }
        },
      ),
    );
  });
});

describe('R18 — resolution is order-independent', () => {
  it('shuffling the grant list and the principal list changes nothing', () => {
    fc.assert(
      fc.property(
        worldArb
          .chain((world) =>
            fc.record({
              world: fc.constant(world),
              grants: grantsArb(world, [PRINCIPALS.self, PRINCIPALS.groupA, PRINCIPALS.groupB], 6),
            }),
          )
          .chain(({ world, grants }) =>
            fc.record({
              world: fc.constant(world),
              grants: fc.constant(grants),
              shuffled: fc.shuffledSubarray(grants, {
                minLength: grants.length,
                maxLength: grants.length,
              }),
              principals: fc.shuffledSubarray(
                [PRINCIPALS.self, PRINCIPALS.groupA, PRINCIPALS.groupB],
                { minLength: 3, maxLength: 3 },
              ),
            }),
          ),
        ({ world, grants, shuffled, principals }) => {
          const ordered = resolveWith(
            world,
            [PRINCIPALS.self, PRINCIPALS.groupA, PRINCIPALS.groupB],
            grants,
          );
          const jumbled = resolveWith(world, principals, shuffled);
          expect(snapshot(world, jumbled)).toBe(snapshot(world, ordered));
        },
      ),
    );
  });
});

describe('R17 / R9 — the ceilings hold whatever the grants say', () => {
  it('a share-link subject never exceeds {schema:view}', () => {
    fc.assert(
      fc.property(
        worldArb.chain((world) =>
          fc.record({
            world: fc.constant(world),
            grants: grantsArb(world, [principalKey('share_link', 'sl_1')], 5),
          }),
        ),
        ({ world, grants }) => {
          const skel = skeletonOf(world);
          const map = resolveWith(world, [principalKey('share_link', 'sl_1')], grants, {
            subject: LINK,
            orgRole: null,
          });
          for (const ref of allRefs(world)) {
            for (const atom of atomsAt(map, skel, ref)) {
              expect(atom).toBe('schema:view');
            }
          }
        },
      ),
    );
  });

  it('an org guest never holds sharing:manage, however it was granted', () => {
    fc.assert(
      fc.property(
        worldArb.chain((world) =>
          fc.record({
            world: fc.constant(world),
            grants: grantsArb(world, [PRINCIPALS.self, PRINCIPALS.groupA], 5),
          }),
        ),
        ({ world, grants }) => {
          const skel = skeletonOf(world);
          const map = resolveWith(world, [PRINCIPALS.self, PRINCIPALS.groupA], grants, {
            orgRole: 'guest',
          });
          for (const ref of allRefs(world)) {
            expect(atomsAt(map, skel, ref).has('sharing:manage')).toBe(false);
          }
        },
      ),
    );
  });
});
