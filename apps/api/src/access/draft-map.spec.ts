import { describe, expect, it } from 'vitest';
import { ALL_ATOMS, EMPTY_ATOMS } from './atoms';
import { buildSkeleton } from './cache-keys';
import { DRAFT_AUTHOR_ATOMS, DRAFT_REVIEW_ATOMS, allAccessMap, draftMap } from './resolve';
import type { ProjectPermissionMap, Subject } from './types';

/**
 * Phase 10 §3 — the three maps a draft can resolve to. The main project has a Billing
 * area with a restricted column, so "complete view" means both every entity and
 * `field:viewRestricted` on Billing.
 */
const MAIN_SKEL = buildSkeleton(
  1,
  ['ar_bill'],
  [
    { id: 'ent_inv', areaId: 'ar_bill' },
    { id: 'ent_aud', areaId: null },
  ],
  ['ent_inv'],
);
const DRAFT_SKEL = buildSkeleton(0, ['ar_draft'], [{ id: 'ent_d1', areaId: 'ar_draft' }], []);
const ANA: Subject = { kind: 'user', userId: 'ana', orgId: 'org' };

const full = allAccessMap('prj_main', MAIN_SKEL, ANA, 'owner', 'mask', 1000);
const withAtoms = (atoms: Iterable<string>): ProjectPermissionMap => {
  const set = new Set(atoms) as ProjectPermissionMap['projectAtoms'];
  return { ...full, orgRole: 'member', projectAtoms: set, areaAtoms: new Map([['ar_bill', set]]) };
};

const draft = (parentMap: ProjectPermissionMap, canEdit: boolean, subject: Subject = ANA) =>
  draftMap({
    draftProjectId: 'prj_draft',
    draftSkel: DRAFT_SKEL,
    parentMap,
    parentSkel: MAIN_SKEL,
    subject,
    canEdit,
    restrictedFieldMode: 'mask',
  });

describe('draftMap', () => {
  it('gives the author of an open request edit, uniformly over the draft', () => {
    const map = draft(full, true);
    expect(map.projectId).toBe('prj_draft');
    expect([...map.projectAtoms].sort()).toEqual([...DRAFT_AUTHOR_ATOMS, 'ai:use'].sort());
    expect(map.projectAtoms.has('sharing:manage')).toBe(false);
    expect(map.areaAtoms.get('ar_draft')).toBe(map.projectAtoms);
    expect(map.validUntil).toBe(full.validUntil);
  });

  it('gives any other complete viewer review atoms only', () => {
    const map = draft(withAtoms(['schema:view', 'field:viewRestricted', 'schema:edit']), false);
    expect([...map.projectAtoms].sort()).toEqual([...DRAFT_REVIEW_ATOMS].sort());
  });

  it('is empty without a complete view: a hidden restricted column is enough', () => {
    const noRestricted = withAtoms(['schema:view', 'schema:edit']);
    expect(draft(noRestricted, true).projectAtoms).toBe(EMPTY_ATOMS);
    const oneArea = { ...withAtoms(ALL_ATOMS), projectAtoms: EMPTY_ATOMS };
    expect(draft(oneArea, true).projectAtoms).toBe(EMPTY_ATOMS);
  });

  it('is empty for a share link, whatever it could see', () => {
    const link: Subject = { kind: 'share_link', shareLinkId: 'sl', projectId: 'prj_main' };
    expect(draft(full, false, link).projectAtoms).toBe(EMPTY_ATOMS);
  });

  it('carries ai:use only when the main project grants it', () => {
    expect(
      draft(withAtoms(['schema:view', 'field:viewRestricted']), true).projectAtoms.has('ai:use'),
    ).toBe(false);
  });
});
