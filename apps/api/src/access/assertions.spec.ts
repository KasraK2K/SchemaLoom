import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { BUILT_IN_ROLES, type AtomSet, type PermissionAtom } from '@schemaloom/contracts';
import { describe, expect, it } from 'vitest';
import { assertAll, assertMayDeleteGrant, assertMayGrant } from './assertions';
import { materialise } from './atoms';
import { buildSkeleton } from './cache-keys';
import { computeProjectMap } from './resolve';
import type { LiveGrant, PrincipalKey, ProjectPermissionMap, ResourceRef, Subject } from './types';

const PROJECT = 'prj_shop';
const SKEL = buildSkeleton(
  1,
  ['ar_bill', 'ar_cat'],
  [
    { id: 'ent_inv', areaId: 'ar_bill' },
    { id: 'ent_emp', areaId: 'ar_bill' },
    { id: 'ent_prod', areaId: 'ar_cat' },
  ],
  ['ent_emp'],
);
const ANA: Subject = { kind: 'user', userId: 'ana', orgId: 'org_acme' };

let seq = 0;
function grant(
  principal: PrincipalKey,
  ref: ResourceRef,
  atoms: AtomSet,
  mods: { canUseAi?: boolean; canViewRestricted?: boolean } = {},
): LiveGrant {
  seq += 1;
  return {
    id: `g${String(seq)}`,
    resourceType: ref.type,
    resourceId: ref.id,
    principalKey: principal,
    atoms: [...atoms],
    canUseAi: mods.canUseAi ?? false,
    canViewRestricted: mods.canViewRestricted ?? false,
    expiresAt: null,
    linkExpiresAt: null,
  };
}

const mapFor = (grants: readonly LiveGrant[]): ProjectPermissionMap =>
  computeProjectMap({
    projectId: PROJECT,
    subject: ANA,
    orgRole: 'member',
    principals: [...new Set(grants.map((g) => g.principalKey))],
    grants,
    skeleton: SKEL,
    restrictedFieldMode: 'mask',
    nowMs: 1_700_000_000_000,
  });

const entity = (id: string): ResourceRef => ({ type: 'entity', id });
const project = (): ResourceRef => ({ type: 'project', id: PROJECT });

/** The body a caller renders. `getResponse()` is how Nest carries a structured 403. */
const bodyOf = (err: unknown): Record<string, unknown> => {
  if (!(err instanceof ForbiddenException) && !(err instanceof NotFoundException)) {
    throw new Error(`expected a Nest HTTP exception, got ${String(err)}`);
  }
  return err.getResponse() as Record<string, unknown>;
};

describe('assertAll — §10.4 all-or-nothing, 404 before 403', () => {
  const map = mapFor([grant('user:ana', { type: 'area', id: 'ar_bill' }, BUILT_IN_ROLES.editor)]);

  it('passes when every ref carries the atom', () => {
    expect(() => {
      assertAll(map, SKEL, [entity('ent_inv'), entity('ent_emp')], 'schema:edit');
    }).not.toThrow();
  });

  it('404s when ANY ref is invisible — even if the rest are fine', () => {
    expect(() => {
      assertAll(map, SKEL, [entity('ent_inv'), entity('ent_prod')], 'schema:edit');
    }).toThrow(NotFoundException);
  });

  it('404s for an id that is not in the project at all', () => {
    expect(() => {
      assertAll(map, SKEL, [entity('ent_nope')], 'schema:view');
    }).toThrow(NotFoundException);
  });

  it('403s, naming the atom and the refs, when visible but not permitted', () => {
    const viewer = mapFor([
      grant('user:ana', { type: 'area', id: 'ar_bill' }, BUILT_IN_ROLES.viewer),
    ]);
    try {
      assertAll(viewer, SKEL, [entity('ent_inv'), entity('ent_emp')], 'schema:edit');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenException);
      const body = bodyOf(err);
      expect(body.code).toBe('forbidden');
      expect(body.atom).toBe('schema:edit');
      expect(body.refs).toHaveLength(2);
    }
  });

  it('refuses a cross-project ref: it is invisible, so it is a 404', () => {
    expect(() => {
      assertAll(map, SKEL, [{ type: 'project', id: 'prj_other' }], 'schema:view');
    }).toThrow(NotFoundException);
  });

  it('passes trivially on an empty ref list', () => {
    expect(() => {
      assertAll(map, SKEL, [], 'schema:edit');
    }).not.toThrow();
  });
});

describe('R4 — assertMayGrant, attenuation measured AT the resource', () => {
  it('rejects a grantor with no sharing:manage', () => {
    const editor = mapFor([grant('user:ana', project(), BUILT_IN_ROLES.editor)]);
    try {
      assertMayGrant(editor, SKEL, entity('ent_emp'), BUILT_IN_ROLES.viewer);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(bodyOf(err).code).toBe('sharing_not_permitted');
    }
  });

  it('lets a project manager hand out anything they hold, including sharing:manage', () => {
    const manager = mapFor([grant('user:ana', project(), BUILT_IN_ROLES.manager)]);
    for (const role of [BUILT_IN_ROLES.viewer, BUILT_IN_ROLES.editor, BUILT_IN_ROLES.manager]) {
      expect(() => {
        assertMayGrant(manager, SKEL, entity('ent_emp'), role);
      }).not.toThrow();
    }
  });

  it('E14: a manager WITHOUT field:viewRestricted cannot pass it on', () => {
    const manager = mapFor([grant('user:ana', project(), BUILT_IN_ROLES.manager)]);
    const proposed = materialise({
      atoms: [...BUILT_IN_ROLES.viewer],
      canUseAi: false,
      canViewRestricted: true,
    });
    try {
      assertMayGrant(manager, SKEL, entity('ent_emp'), proposed);
      expect.unreachable('should have thrown');
    } catch (err) {
      const body = bodyOf(err);
      expect(body.code).toBe('escalation');
      expect(body.atoms).toEqual(['field:viewRestricted']);
      expect(body.remedy).toBe('delete_narrowing_grant');
    }
  });

  it('...and CAN pass it on once they hold it', () => {
    const manager = mapFor([
      grant('user:ana', project(), BUILT_IN_ROLES.manager, { canViewRestricted: true }),
    ]);
    const proposed = materialise({
      atoms: [...BUILT_IN_ROLES.viewer],
      canUseAi: false,
      canViewRestricted: true,
    });
    expect(() => {
      assertMayGrant(manager, SKEL, entity('ent_emp'), proposed);
    }).not.toThrow();
  });

  it('E13/R6: area sharing:manage does not reach the project', () => {
    const areaManager = mapFor([
      grant('user:ana', { type: 'area', id: 'ar_bill' }, BUILT_IN_ROLES.manager),
    ]);
    try {
      assertMayGrant(areaManager, SKEL, project(), BUILT_IN_ROLES.viewer);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(bodyOf(err).code).toBe('sharing_not_permitted');
    }
    // ...but it does reach the entities under that area.
    expect(() => {
      assertMayGrant(areaManager, SKEL, entity('ent_emp'), BUILT_IN_ROLES.viewer);
    }).not.toThrow();
  });
});

describe('E12 — the self-narrowed manager, both directions', () => {
  const selfNarrowed = mapFor([
    grant('user:ana', project(), BUILT_IN_ROLES.manager),
    grant('user:ana', entity('ent_emp'), BUILT_IN_ROLES.viewer),
  ]);

  it('(a) she may DELETE the narrowing grant — R4a plus the step-4b downward union', () => {
    expect(() => {
      assertMayDeleteGrant(selfNarrowed, SKEL, entity('ent_emp'));
    }).not.toThrow();
  });

  it('(b) she may NOT widen it in place — 403 escalation naming the remedy', () => {
    try {
      assertMayGrant(selfNarrowed, SKEL, entity('ent_emp'), BUILT_IN_ROLES.editor);
      expect.unreachable('should have thrown');
    } catch (err) {
      const body = bodyOf(err);
      expect(body.code).toBe('escalation');
      // R4's `escalation` is `proposed \ mine`, so it is every atom editor has that
      // viewer does not — four, not the two §7.6's E12 row prints. That row's pair is
      // the editor-minus-DOCUMENTER difference; the narrowing grant it describes is a
      // `viewer`. The rule text ("a subset of the grantor's own effective atoms at R
      // exactly") is what is implemented; the example's list is a slip.
      expect(new Set(body.atoms as PermissionAtom[])).toEqual(
        new Set(['schema:edit', 'history:view', 'docs:edit', 'comment:create']),
      );
      expect(body.remedy).toBe('delete_narrowing_grant');
    }
  });

  it('she may still re-grant viewer there — it is not an escalation', () => {
    expect(() => {
      assertMayGrant(selfNarrowed, SKEL, entity('ent_emp'), BUILT_IN_ROLES.viewer);
    }).not.toThrow();
  });
});

describe('R4a — assertMayDeleteGrant is R5 only', () => {
  it('rejects a grantor with no sharing:manage anywhere on the chain', () => {
    const editor = mapFor([grant('user:ana', project(), BUILT_IN_ROLES.editor)]);
    try {
      assertMayDeleteGrant(editor, SKEL, entity('ent_emp'));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(bodyOf(err).code).toBe('sharing_not_permitted');
    }
  });

  it('accepts a project manager deleting a grant on any entity below', () => {
    const manager = mapFor([grant('user:ana', project(), BUILT_IN_ROLES.manager)]);
    for (const id of ['ent_inv', 'ent_emp', 'ent_prod']) {
      expect(() => {
        assertMayDeleteGrant(manager, SKEL, entity(id));
      }).not.toThrow();
    }
  });
});
