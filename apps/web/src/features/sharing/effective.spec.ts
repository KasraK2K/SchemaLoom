import { describe, expect, it } from 'vitest';
import {
  ALL_ATOMS,
  ancestorChain,
  decidingOwnGrant,
  effectiveAtomsAt,
  grantAtoms,
  nearestGrants,
} from './effective';
import {
  ANA,
  ANALYSTS,
  BILLING,
  INVOICES,
  PROJECT,
  RESOURCES,
  anaEditorOnProject,
  entry,
  grant,
  role,
} from './access-fixture';

describe('ancestorChain', () => {
  it('is nearest-first: entity, area, project', () => {
    expect(ancestorChain(RESOURCES, INVOICES).map((node) => node.id)).toEqual([
      INVOICES.id,
      BILLING.id,
      PROJECT.id,
    ]);
  });

  it('is empty for a resource the payload does not carry', () => {
    expect(ancestorChain(RESOURCES, { id: 'ent_nowhere' })).toEqual([]);
  });

  it('terminates on a parent cycle rather than hanging the render', () => {
    const looped = [
      { ...PROJECT, parentId: BILLING.id },
      { ...BILLING, parentId: PROJECT.id },
    ];
    expect(ancestorChain(looped, BILLING).map((node) => node.id)).toEqual([
      BILLING.id,
      PROJECT.id,
    ]);
  });
});

describe('grantAtoms', () => {
  it('unions the toggles in and never subtracts', () => {
    const viewer = role('viewer');
    const plain = grantAtoms({ atoms: viewer.atoms, canUseAi: false, canViewRestricted: false });
    const toggled = grantAtoms({ atoms: viewer.atoms, canUseAi: true, canViewRestricted: true });
    for (const atom of plain) expect(toggled.has(atom)).toBe(true);
    expect(toggled.has('ai:use')).toBe(true);
    expect(toggled.has('field:viewRestricted')).toBe(true);
  });

  it('closes a toggle-only grant under R1 so it still implies schema:view', () => {
    expect(grantAtoms({ atoms: [], canUseAi: true, canViewRestricted: false })).toContain(
      'schema:view',
    );
  });
});

describe('nearestGrants — R15, per principal', () => {
  it('picks the nearest level for each principal independently', () => {
    const ana = entry(ANA, [
      grant(ANA, PROJECT, 'editor'),
      grant(ANA, BILLING, 'viewer'),
      grant(ANALYSTS, PROJECT, 'commenter'),
    ]);
    const picked = nearestGrants(ana.grants, ancestorChain(RESOURCES, BILLING));
    expect(picked.map((g) => `${g.principal.id}@${g.resourceId}`).sort()).toEqual(
      [`${ANA.id}@${BILLING.id}`, `${ANALYSTS.id}@${PROJECT.id}`].sort(),
    );
  });

  it('ignores grants on resources outside the chain', () => {
    const ana = entry(ANA, [grant(ANA, INVOICES, 'manager')]);
    expect(nearestGrants(ana.grants, ancestorChain(RESOURCES, BILLING))).toEqual([]);
  });
});

describe('effectiveAtomsAt', () => {
  it('is the project role at the project', () => {
    const atoms = effectiveAtomsAt(anaEditorOnProject(), ancestorChain(RESOURCES, PROJECT));
    expect(atoms.has('schema:edit')).toBe(true);
  });

  it('drops schema:edit at an area where a nearer Viewer grant wins — the footgun', () => {
    const ana = entry(ANA, [grant(ANA, PROJECT, 'editor'), grant(ANA, BILLING, 'viewer')]);
    expect(effectiveAtomsAt(ana, ancestorChain(RESOURCES, PROJECT)).has('schema:edit')).toBe(true);
    expect(effectiveAtomsAt(ana, ancestorChain(RESOURCES, BILLING)).has('schema:edit')).toBe(
      false,
    );
    // and it propagates to everything inside the area
    expect(effectiveAtomsAt(ana, ancestorChain(RESOURCES, INVOICES)).has('schema:edit')).toBe(
      false,
    );
  });

  it('does NOT narrow a second principal: the group grant survives (E3)', () => {
    const ana = entry(ANA, [
      grant(ANALYSTS, PROJECT, 'editor'),
      grant(ANA, BILLING, 'viewer'),
    ]);
    expect(effectiveAtomsAt(ana, ancestorChain(RESOURCES, BILLING)).has('schema:edit')).toBe(true);
  });

  it('gives an org owner every atom whatever their grants say (R13)', () => {
    const boss = entry(ANA, [grant(ANA, BILLING, 'viewer')], { orgRole: 'owner' });
    expect(effectiveAtomsAt(boss, ancestorChain(RESOURCES, BILLING))).toEqual(new Set(ALL_ATOMS));
  });

  it('gives an org admin only what their grants say — R13 is owner-only', () => {
    const admin = entry(ANA, [grant(ANA, BILLING, 'viewer')], { orgRole: 'admin' });
    expect(effectiveAtomsAt(admin, ancestorChain(RESOURCES, BILLING))).not.toEqual(new Set(ALL_ATOMS));
    expect(effectiveAtomsAt(admin, ancestorChain(RESOURCES, BILLING)).has('schema:view')).toBe(true);
  });
});

describe('decidingOwnGrant', () => {
  it('returns the principal’s own nearest grant, not a group’s', () => {
    const ana = entry(ANA, [
      grant(ANALYSTS, BILLING, 'manager'),
      grant(ANA, PROJECT, 'editor'),
    ]);
    expect(decidingOwnGrant(ana, ancestorChain(RESOURCES, BILLING))?.roleKey).toBe('editor');
  });
});
