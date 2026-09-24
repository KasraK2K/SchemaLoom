import {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_ORDER,
  PERMISSION_ATOMS,
  type AtomSet,
  type BuiltInResourceRole,
  type OrgRole,
  type PermissionAtom,
  type RestrictedFieldMode,
} from '@schemaloom/contracts';
import { describe, expect, it } from 'vitest';
import { ALL_ATOMS } from './atoms';
import { buildSkeleton } from './cache-keys';
import {
  PERM_TTL_MS,
  allAccessMap,
  ancestorChain,
  atomsAt,
  canOpenProject,
  computeProjectMap,
  emptyMap,
  indexGrants,
  nextExpiryOf,
  restrictedOkEntityIds,
  visibleEntityIds,
} from './resolve';
import type {
  DroppedGrantReason,
  LiveGrant,
  PrincipalKey,
  ProjectPermissionMap,
  ResourceRef,
  Subject,
} from './types';

/**
 * Doc 05 §7.6's fixture, verbatim. Every worked example below is keyed to its row in that
 * table, so a rule change that breaks one of them breaks the named example too.
 *
 *   prj_shop
 *   ├── ar_bill "Billing"   ent_inv, ent_pay, ent_emp (ent_emp has a restricted field)
 *   ├── ar_cat  "Catalog"   ent_prod
 *   └── (no area)           ent_aud
 */
const PROJECT = 'prj_shop';
const SKEL = buildSkeleton(
  7,
  ['ar_bill', 'ar_cat'],
  [
    { id: 'ent_inv', areaId: 'ar_bill' },
    { id: 'ent_pay', areaId: 'ar_bill' },
    { id: 'ent_emp', areaId: 'ar_bill' },
    { id: 'ent_prod', areaId: 'ar_cat' },
    { id: 'ent_aud', areaId: null },
  ],
  ['ent_emp'],
);

const ANA: Subject = { kind: 'user', userId: 'ana', orgId: 'org_acme' };
const LINK: Subject = { kind: 'share_link', shareLinkId: 'sl_1', projectId: PROJECT };
const NOW = 1_700_000_000_000;

let seq = 0;

interface GrantOpts {
  canUseAi?: boolean;
  canViewRestricted?: boolean;
  expiresAt?: Date;
  linkExpiresAt?: Date;
  atoms?: readonly string[];
}

function grant(
  principal: PrincipalKey,
  ref: ResourceRef,
  role: BuiltInResourceRole,
  opts: GrantOpts = {},
): LiveGrant {
  seq += 1;
  return {
    id: `g${String(seq)}`,
    resourceType: ref.type,
    resourceId: ref.id,
    principalKey: principal,
    atoms: opts.atoms ?? [...BUILT_IN_ROLES[role]],
    canUseAi: opts.canUseAi ?? false,
    canViewRestricted: opts.canViewRestricted ?? false,
    expiresAt: opts.expiresAt ?? null,
    linkExpiresAt: opts.linkExpiresAt ?? null,
  };
}

interface ResolveOpts {
  subject?: Subject;
  orgRole?: OrgRole | null;
  principals?: readonly PrincipalKey[];
  grants?: readonly LiveGrant[];
  restrictedFieldMode?: RestrictedFieldMode;
  nowMs?: number;
  onDroppedGrant?: (reason: DroppedGrantReason, grant: LiveGrant) => void;
}

/**
 * Mirrors §7.5 steps 1-7 exactly as the service runs them, R13 short-circuit included,
 * so a matrix row for `owner` exercises the same code path a request would.
 */
function resolve(opts: ResolveOpts = {}): ProjectPermissionMap {
  const subject = opts.subject ?? ANA;
  const orgRole = opts.orgRole === undefined ? 'member' : opts.orgRole;
  const mode = opts.restrictedFieldMode ?? 'mask';
  const nowMs = opts.nowMs ?? NOW;
  if (orgRole === 'owner' || orgRole === 'admin') {
    return allAccessMap(PROJECT, SKEL, subject, orgRole, mode, nowMs);
  }
  const grants = opts.grants ?? [];
  return computeProjectMap({
    projectId: PROJECT,
    subject,
    orgRole,
    principals: opts.principals ?? [...new Set(grants.map((g) => g.principalKey))],
    grants,
    skeleton: SKEL,
    restrictedFieldMode: mode,
    nowMs,
    onDroppedGrant: opts.onDroppedGrant,
  });
}

const at = (map: ProjectPermissionMap, ref: ResourceRef): AtomSet => atomsAt(map, SKEL, ref);
const entity = (id: string): ResourceRef => ({ type: 'entity', id });
const area = (id: string): ResourceRef => ({ type: 'area', id });
const project = (): ResourceRef => ({ type: 'project', id: PROJECT });
const sorted = (s: AtomSet): string[] => [...s].sort();

// =========================================================================================
// The table-driven permission matrix: {org role} × {grant level} × {role} × {atom}.
// =========================================================================================

const LEVELS: Record<string, ResourceRef> = {
  project: { type: 'project', id: PROJECT },
  area: { type: 'area', id: 'ar_bill' },
  entity: { type: 'entity', id: 'ent_emp' },
};

const cases = (['owner', 'admin', 'member', 'guest'] as const).flatMap((orgRole) =>
  Object.keys(LEVELS).flatMap((level) =>
    BUILT_IN_ROLE_ORDER.map((role) => ({ orgRole, level, role })),
  ),
);

describe('permission matrix — one grant, measured at ent_emp', () => {
  it.each(cases)('org=$orgRole grant@$level role=$role', ({ orgRole, level, role }) => {
    const ref = LEVELS[level];
    expect(ref).toBeDefined();
    if (!ref) return;
    const map = resolve({
      orgRole,
      grants: [grant('user:ana', ref, role)],
    });
    const actual = at(map, entity('ent_emp'));

    let expected: AtomSet;
    if (orgRole === 'owner' || orgRole === 'admin') {
      // R13 — all nine, whatever the grant says, at every level.
      expected = ALL_ATOMS;
    } else {
      const fromRole = new Set(BUILT_IN_ROLES[role]);
      // R9/R17 — a guest never holds sharing:manage, whatever role they were given.
      if (orgRole === 'guest') fromRole.delete('sharing:manage');
      expected = fromRole;
    }
    expect(sorted(actual)).toEqual(sorted(expected));
  });

  it('covers every atom in the vocabulary', () => {
    const map = resolve({ orgRole: 'member', grants: [grant('user:ana', project(), 'manager')] });
    const full = resolve({
      orgRole: 'member',
      grants: [
        grant('user:ana', project(), 'manager', { canUseAi: true, canViewRestricted: true }),
      ],
    });
    expect(sorted(full.projectAtoms)).toEqual(sorted(new Set(PERMISSION_ATOMS)));
    // R7 — the modifiers are the only source of these two for a built-in role.
    expect(map.projectAtoms.has('ai:use')).toBe(false);
    expect(map.projectAtoms.has('field:viewRestricted')).toBe(false);
  });
});

// =========================================================================================
// R13 — the org owner/admin short-circuit is INESCAPABLE.
// =========================================================================================

describe('R13 — org owner/admin short-circuit', () => {
  it('E8: a narrowing entity grant on an admin is inert', () => {
    const map = resolve({
      orgRole: 'admin',
      grants: [grant('user:ana', entity('ent_emp'), 'viewer')],
    });
    expect(sorted(at(map, entity('ent_emp')))).toEqual(sorted(ALL_ATOMS));
    expect(sorted(at(map, area('ar_bill')))).toEqual(sorted(ALL_ATOMS));
    expect(sorted(at(map, project()))).toEqual(sorted(ALL_ATOMS));
  });

  it('gives an owner every atom on every resource, including an entity in no area', () => {
    const map = resolve({ orgRole: 'owner', grants: [] });
    for (const e of SKEL.entities) expect(sorted(at(map, entity(e.id)))).toEqual(sorted(ALL_ATOMS));
    expect(map.entityOverrides.size).toBe(0);
    expect(canOpenProject(map)).toBe(true);
  });

  it('an admin sees every entity — the skeleton is built BEFORE the short-circuit', () => {
    const map = resolve({ orgRole: 'admin' });
    expect(visibleEntityIds(map, SKEL).size).toBe(SKEL.entities.length);
    expect(restrictedOkEntityIds(map, SKEL).size).toBe(SKEL.entities.length);
  });
});

// =========================================================================================
// R14 — no deny grants. A grant can only add.
// =========================================================================================

describe('R14 — grants only ever add', () => {
  it('adding any grant to any world is monotone at every resource', () => {
    const base = [grant('user:ana', area('ar_bill'), 'viewer')];
    const extra = [
      grant('group:analysts', entity('ent_emp'), 'commenter'),
      grant('group:contractors', project(), 'documenter'),
    ];
    const principals: PrincipalKey[] = ['user:ana', 'group:analysts', 'group:contractors'];
    const before = resolve({ principals, grants: base });
    const after = resolve({ principals, grants: [...base, ...extra] });

    const refs: ResourceRef[] = [project(), area('ar_bill'), area('ar_cat')];
    for (const e of SKEL.entities) refs.push(entity(e.id));
    for (const ref of refs) {
      for (const atom of at(before, ref)) {
        expect(at(after, ref).has(atom), `${ref.type} ${ref.id} lost ${atom}`).toBe(true);
      }
    }
  });

  it('a LiveGrant has no shape in which a deny could be expressed', () => {
    const g = grant('user:ana', project(), 'viewer');
    expect(Object.keys(g).sort()).toEqual([
      'atoms',
      'canUseAi',
      'canViewRestricted',
      'expiresAt',
      'id',
      'linkExpiresAt',
      'principalKey',
      'resourceId',
      'resourceType',
    ]);
  });
});

// =========================================================================================
// R15 — per-principal NEAREST-LEVEL-WINS.
// =========================================================================================

describe('R15 — nearest level wins, per principal', () => {
  it('E1: project editor + entity viewer on the SAME principal is viewer at that entity', () => {
    const map = resolve({
      grants: [
        grant('user:ana', project(), 'editor'),
        grant('user:ana', entity('ent_emp'), 'viewer'),
      ],
    });
    expect(sorted(at(map, entity('ent_emp')))).toEqual(sorted(BUILT_IN_ROLES.viewer));
    expect(at(map, entity('ent_emp')).has('schema:edit')).toBe(false);
    // The project grant is DISCARDED at that entity, not unioned — but still decides
    // everywhere it is the nearest level.
    expect(sorted(at(map, entity('ent_inv')))).toEqual(sorted(BUILT_IN_ROLES.editor));
  });

  it('project Editor + area Viewer makes that area READ-ONLY and leaves the rest editable', () => {
    const map = resolve({
      grants: [
        grant('user:ana', project(), 'editor'),
        grant('user:ana', area('ar_bill'), 'viewer'),
      ],
    });
    for (const id of ['ent_inv', 'ent_pay', 'ent_emp']) {
      expect(at(map, entity(id)).has('schema:edit'), `${id} should be read-only`).toBe(false);
      expect(at(map, entity(id)).has('schema:view')).toBe(true);
    }
    expect(at(map, entity('ent_prod')).has('schema:edit')).toBe(true);
    expect(at(map, entity('ent_aud')).has('schema:edit')).toBe(true);
  });

  it('E2: specificity strengthens as readily as it weakens', () => {
    const map = resolve({
      grants: [
        grant('user:dana', project(), 'viewer'),
        grant('user:dana', area('ar_bill'), 'editor'),
      ],
      principals: ['user:dana'],
    });
    expect(sorted(at(map, entity('ent_inv')))).toEqual(sorted(BUILT_IN_ROLES.editor));
    expect(sorted(at(map, entity('ent_prod')))).toEqual(sorted(BUILT_IN_ROLES.viewer));
  });

  it('E11: an entity in no area inherits from the project, never from an area', () => {
    const map = resolve({ grants: [grant('user:ana', area('ar_bill'), 'editor')] });
    expect(at(map, entity('ent_aud')).size).toBe(0);
    expect(at(map, entity('ent_inv')).has('schema:edit')).toBe(true);
    // ...and it can still open the project (§7.9), which is workflow #2's freelancer.
    expect(canOpenProject(map)).toBe(true);
  });
});

// =========================================================================================
// R16 — union ACROSS principals, at each principal's own deciding level.
// =========================================================================================

describe('R16 — union across principals', () => {
  it('E3: a narrowing USER grant does not beat a wider GROUP grant at the same level', () => {
    const map = resolve({
      principals: ['user:ana', 'group:analysts'],
      grants: [
        grant('user:ana', entity('ent_emp'), 'viewer'),
        grant('group:analysts', entity('ent_emp'), 'editor'),
      ],
    });
    expect(sorted(at(map, entity('ent_emp')))).toEqual(sorted(BUILT_IN_ROLES.editor));
  });

  it('E4: two group grants union to the higher role, because built-ins are a chain', () => {
    const map = resolve({
      principals: ['group:a', 'group:b'],
      grants: [grant('group:a', project(), 'editor'), grant('group:b', project(), 'commenter')],
    });
    expect(sorted(map.projectAtoms)).toEqual(sorted(BUILT_IN_ROLES.editor));
  });

  it("E5: a group's narrow entity grant cannot demote a broader PERSONAL grant", () => {
    const map = resolve({
      principals: ['user:ana', 'group:analysts'],
      grants: [
        grant('user:ana', project(), 'manager'),
        grant('group:analysts', entity('ent_emp'), 'viewer'),
      ],
    });
    expect(sorted(at(map, entity('ent_emp')))).toEqual(sorted(BUILT_IN_ROLES.manager));
  });

  it('adding a group grant never REMOVES anyone access', () => {
    const personal = [grant('user:ana', project(), 'manager')];
    const before = resolve({ principals: ['user:ana'], grants: personal });
    const after = resolve({
      principals: ['user:ana', 'group:analysts'],
      grants: [...personal, grant('group:analysts', entity('ent_emp'), 'viewer')],
    });
    for (const e of SKEL.entities) {
      for (const atom of at(before, entity(e.id))) {
        expect(at(after, entity(e.id)).has(atom), `${e.id} lost ${atom}`).toBe(true);
      }
    }
  });

  it('E5b: R15 replaces on the SAME principal, then step 4b restores sharing:manage', () => {
    const map = resolve({
      grants: [
        grant('user:ana', project(), 'manager'),
        grant('user:ana', entity('ent_emp'), 'viewer'),
      ],
    });
    const atoms = at(map, entity('ent_emp'));
    expect(sorted(atoms)).toEqual(sorted(new Set([...BUILT_IN_ROLES.viewer, 'sharing:manage'])));
    expect(atoms.has('schema:edit')).toBe(false);
  });
});

// =========================================================================================
// R5 / step 4b — the downward `sharing:manage` union, and R6's boundary.
// =========================================================================================

describe('R5 / step 4b — sharing:manage unions DOWNWARD only', () => {
  it('project manager holds sharing:manage at every area and entity', () => {
    const map = resolve({ grants: [grant('user:ana', project(), 'manager')] });
    expect(map.areaAtoms.get('ar_bill')?.has('sharing:manage')).toBe(true);
    for (const e of SKEL.entities) expect(at(map, entity(e.id)).has('sharing:manage')).toBe(true);
  });

  it('E13/R6: area manager does NOT reach the project or a sibling area', () => {
    const map = resolve({ grants: [grant('user:ana', area('ar_bill'), 'manager')] });
    expect(at(map, entity('ent_inv')).has('sharing:manage')).toBe(true);
    expect(map.projectAtoms.has('sharing:manage')).toBe(false);
    expect(map.areaAtoms.get('ar_cat')?.has('sharing:manage') ?? false).toBe(false);
    expect(at(map, entity('ent_aud')).has('sharing:manage')).toBe(false);
  });

  it('the Lemma: the downward union never introduces schema:view where there was none', () => {
    const map = resolve({ grants: [grant('user:ana', area('ar_bill'), 'manager')] });
    expect(at(map, entity('ent_prod')).size).toBe(0);
    expect(at(map, entity('ent_aud')).size).toBe(0);
  });
});

// =========================================================================================
// R17 — subject-class ceilings, intersected LAST.
// =========================================================================================

describe('R17 — subject-class ceilings', () => {
  it('E10: a share link carrying manager + canUseAi still gets only schema:view', () => {
    const map = resolve({
      subject: LINK,
      orgRole: null,
      grants: [
        grant('share_link:sl_1', project(), 'manager', {
          canUseAi: true,
          canViewRestricted: true,
        }),
      ],
      principals: ['share_link:sl_1'],
    });
    expect(sorted(map.projectAtoms)).toEqual(['schema:view']);
    for (const e of SKEL.entities) expect(sorted(at(map, entity(e.id)))).toEqual(['schema:view']);
    expect(map.orgRole).toBeNull();
  });

  it('the ceiling is applied after the union, not per grant', () => {
    const map = resolve({
      subject: LINK,
      orgRole: null,
      principals: ['share_link:sl_1'],
      grants: [
        grant('share_link:sl_1', project(), 'editor'),
        grant('share_link:sl_1', entity('ent_emp'), 'manager'),
      ],
    });
    expect(sorted(at(map, entity('ent_emp')))).toEqual(['schema:view']);
    expect(map.entityOverrides.size).toBe(0);
  });

  it('E9: a guest granted area manager keeps everything BUT sharing:manage', () => {
    const map = resolve({
      orgRole: 'guest',
      grants: [grant('user:dana', area('ar_bill'), 'manager')],
      principals: ['user:dana'],
    });
    const expected = new Set(BUILT_IN_ROLES.manager);
    expected.delete('sharing:manage');
    expect(sorted(at(map, entity('ent_inv')))).toEqual(sorted(expected));
    expect(at(map, entity('ent_inv')).has('schema:edit')).toBe(true);
  });

  it('a guest loses sharing:manage even when it arrived by the downward union', () => {
    const map = resolve({
      orgRole: 'guest',
      grants: [
        grant('user:dana', project(), 'manager'),
        grant('user:dana', entity('ent_emp'), 'viewer'),
      ],
      principals: ['user:dana'],
    });
    expect(at(map, entity('ent_emp')).has('sharing:manage')).toBe(false);
    expect(map.projectAtoms.has('sharing:manage')).toBe(false);
  });
});

// =========================================================================================
// R18 — determinism.
// =========================================================================================

describe('R18 — determinism', () => {
  const grants = [
    grant('user:ana', project(), 'editor'),
    grant('user:ana', entity('ent_emp'), 'viewer'),
    grant('group:analysts', area('ar_bill'), 'commenter'),
    grant('group:contractors', entity('ent_prod'), 'manager'),
  ];
  const principals: PrincipalKey[] = ['user:ana', 'group:analysts', 'group:contractors'];

  const shape = (m: ProjectPermissionMap): unknown => ({
    project: sorted(m.projectAtoms),
    areas: [...m.areaAtoms].map(([k, v]) => [k, sorted(v)]).sort(),
    overrides: [...m.entityOverrides].map(([k, v]) => [k, sorted(v)]).sort(),
  });

  it('shuffling the grant order changes nothing', () => {
    const base = shape(resolve({ principals, grants }));
    for (const order of [
      [3, 1, 0, 2],
      [2, 3, 1, 0],
      [1, 0, 3, 2],
    ]) {
      const shuffled = order.map((i) => grants[i]).filter((g): g is LiveGrant => g !== undefined);
      expect(shape(resolve({ principals, grants: shuffled }))).toEqual(base);
    }
  });

  it('shuffling the PRINCIPAL order changes nothing', () => {
    const base = shape(resolve({ principals, grants }));
    const reversed = [...principals].reverse();
    expect(shape(resolve({ principals: reversed, grants }))).toEqual(base);
  });

  it('is a pure function: same inputs, same output, no hidden clock inside the rules', () => {
    const a = resolve({ principals, grants, nowMs: NOW });
    const b = resolve({ principals, grants, nowMs: NOW });
    expect(shape(a)).toEqual(shape(b));
    expect(a.validUntil).toBe(b.validUntil);
  });
});

// =========================================================================================
// entityOverrides — the payload rule.
// =========================================================================================

describe('entityOverrides holds only entities that genuinely differ', () => {
  it('is EMPTY when every entity inherits — the 300-entity project case', () => {
    const map = resolve({ grants: [grant('user:ana', project(), 'editor')] });
    expect(map.entityOverrides.size).toBe(0);
    for (const e of SKEL.entities) {
      expect(sorted(at(map, entity(e.id)))).toEqual(sorted(BUILT_IN_ROLES.editor));
    }
  });

  it('is empty for an area-only grant too: the area level already says it', () => {
    const map = resolve({ grants: [grant('user:ana', area('ar_bill'), 'editor')] });
    expect(map.entityOverrides.size).toBe(0);
  });

  it('holds exactly the one entity whose grant differs from its area', () => {
    const map = resolve({
      grants: [
        grant('user:ana', project(), 'editor'),
        grant('user:ana', entity('ent_emp'), 'viewer'),
      ],
    });
    expect([...map.entityOverrides.keys()]).toEqual(['ent_emp']);
  });

  it('drops an entity grant that merely restates what is inherited', () => {
    const map = resolve({
      grants: [
        grant('user:ana', project(), 'editor'),
        grant('user:ana', entity('ent_emp'), 'editor'),
      ],
    });
    expect(map.entityOverrides.size).toBe(0);
    expect(sorted(at(map, entity('ent_emp')))).toEqual(sorted(BUILT_IN_ROLES.editor));
  });
});

// =========================================================================================
// §7.15 — the polymorphic pointer, and R12/TTL inputs.
// =========================================================================================

describe('indexGrants — §7.15 integrity', () => {
  const drops = (grants: LiveGrant[]): DroppedGrantReason[] => {
    const seen: DroppedGrantReason[] = [];
    indexGrants(grants, PROJECT, SKEL, (reason) => seen.push(reason));
    return seen;
  };

  it('drops a project grant pointing at a DIFFERENT project', () => {
    expect(drops([grant('user:ana', { type: 'project', id: 'prj_other' }, 'manager')])).toEqual([
      'grant_project_mismatch',
    ]);
  });

  it('drops a dangling area grant and a dangling entity grant', () => {
    expect(drops([grant('user:ana', area('ar_gone'), 'manager')])).toEqual([
      'grant_dangling_area',
    ]);
    expect(drops([grant('user:ana', entity('ent_gone'), 'manager')])).toEqual([
      'grant_dangling_entity',
    ]);
  });

  it('a dropped row grants nothing', () => {
    const map = resolve({
      grants: [grant('user:ana', { type: 'project', id: 'prj_other' }, 'manager')],
    });
    expect(canOpenProject(map)).toBe(false);
  });

  it('drops an atom string the build does not know, rather than carrying it', () => {
    const map = resolve({
      grants: [
        grant('user:ana', project(), 'viewer', { atoms: ['schema:view', 'billing:god-mode'] }),
      ],
    });
    expect(sorted(map.projectAtoms)).toEqual(['schema:view']);
  });
});

describe('nextExpiryOf — R12.1 plus the share link, both', () => {
  it('is null when nothing expires', () => {
    expect(nextExpiryOf([grant('user:ana', project(), 'viewer')])).toBeNull();
  });

  it('takes the EARLIEST of grant expiry and link expiry', () => {
    const soon = new Date(NOW + 30_000);
    const later = new Date(NOW + 900_000);
    const g = grant('share_link:sl_1', project(), 'viewer', {
      expiresAt: later,
      linkExpiresAt: soon,
    });
    expect(nextExpiryOf([g])).toBe(soon.getTime());
  });

  it('caps validUntil, so a link expiring in 30 s cannot leave a 300 s map', () => {
    const soon = new Date(NOW + 30_000);
    const map = resolve({
      subject: LINK,
      orgRole: null,
      principals: ['share_link:sl_1'],
      grants: [grant('share_link:sl_1', project(), 'viewer', { linkExpiresAt: soon })],
    });
    expect(map.validUntil).toBe(soon.getTime());
    expect(map.validUntil).toBeLessThan(NOW + PERM_TTL_MS);
  });

  it('otherwise validUntil is now + the 300 s cap', () => {
    const map = resolve({ grants: [grant('user:ana', project(), 'viewer')] });
    expect(map.validUntil).toBe(NOW + PERM_TTL_MS);
  });
});

// =========================================================================================
// §7.9 / §7.2 — the derived helpers.
// =========================================================================================

describe('canOpenProject and ancestry', () => {
  it('is false for a subject with nothing, and never caches an EMPTY_MAP shape', () => {
    const map = emptyMap(PROJECT, ANA);
    expect(canOpenProject(map)).toBe(false);
    expect(map.validUntil).toBe(0);
    expect(map.orgRole).toBeNull();
  });

  it('is true from an ENTITY grant alone — no project-level view needed', () => {
    const map = resolve({ grants: [grant('user:ana', entity('ent_emp'), 'viewer')] });
    expect(map.projectAtoms.size).toBe(0);
    expect(canOpenProject(map)).toBe(true);
  });

  it('puts the area in an entity chain only when the entity has one', () => {
    expect(ancestorChain(PROJECT, entity('ent_emp'), SKEL)).toEqual([
      { type: 'entity', id: 'ent_emp' },
      { type: 'area', id: 'ar_bill' },
      { type: 'project', id: PROJECT },
    ]);
    expect(ancestorChain(PROJECT, entity('ent_aud'), SKEL)).toEqual([
      { type: 'entity', id: 'ent_aud' },
      { type: 'project', id: PROJECT },
    ]);
    expect(ancestorChain(PROJECT, area('ar_cat'), SKEL)).toEqual([
      { type: 'area', id: 'ar_cat' },
      { type: 'project', id: PROJECT },
    ]);
  });

  it('atomsAt returns nothing for an unknown entity id and a foreign project id', () => {
    const map = resolve({ grants: [grant('user:ana', project(), 'manager')] });
    expect(at(map, entity('ent_nope')).size).toBe(0);
    expect(at(map, { type: 'project', id: 'prj_other' }).size).toBe(0);
    expect(at(map, area('ar_nope')).size).toBe(0);
  });

  it('restrictedOkEntityIds is per entity, not per subject', () => {
    const map = resolve({
      grants: [
        grant('user:ana', project(), 'viewer'),
        grant('user:ana', area('ar_bill'), 'viewer', { canViewRestricted: true }),
      ],
    });
    expect([...restrictedOkEntityIds(map, SKEL)].sort()).toEqual(['ent_emp', 'ent_inv', 'ent_pay']);
    expect(visibleEntityIds(map, SKEL).size).toBe(5);
  });

  it('carries restrictedFieldMode through untouched', () => {
    expect(resolve({ restrictedFieldMode: 'hide' }).restrictedFieldMode).toBe('hide');
    expect(resolve({ orgRole: 'owner', restrictedFieldMode: 'hide' }).restrictedFieldMode).toBe(
      'hide',
    );
  });
});

describe('R7 — modifier booleans are additive only', () => {
  it('a toggle adds an atom the built-in role lacks', () => {
    const map = resolve({
      grants: [grant('user:ana', project(), 'viewer', { canUseAi: true })],
    });
    expect(map.projectAtoms.has('ai:use')).toBe(true);
  });

  it('a FALSE toggle cannot remove an atom a custom role contains', () => {
    const atoms: PermissionAtom[] = ['schema:view', 'ai:use', 'field:viewRestricted'];
    const map = resolve({
      grants: [
        grant('user:ana', project(), 'viewer', { atoms, canUseAi: false, canViewRestricted: false }),
      ],
    });
    expect(map.projectAtoms.has('ai:use')).toBe(true);
    expect(map.projectAtoms.has('field:viewRestricted')).toBe(true);
  });
});
