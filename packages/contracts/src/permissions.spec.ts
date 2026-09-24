import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_ORDER,
  BUILTIN_ROLE_IDS,
  PERMISSION_ATOMS,
  closeAtoms,
  normalizeRoleAtoms,
  type PermissionAtom,
} from './permissions.js';

describe('permission atoms', () => {
  it('has exactly the nine atoms C5 fixes, with no duplicates', () => {
    expect(PERMISSION_ATOMS).toHaveLength(9);
    expect(new Set(PERMISSION_ATOMS).size).toBe(9);
  });

  it('R1: any non-empty atom set implies schema:view', () => {
    for (const atom of PERMISSION_ATOMS) {
      expect(closeAtoms([atom]).has('schema:view')).toBe(true);
    }
  });

  it('R1: the empty set stays empty — no access is not "view access"', () => {
    expect(closeAtoms([]).size).toBe(0);
  });

  it('closeAtoms is idempotent', () => {
    const once = closeAtoms(['docs:edit']);
    expect(closeAtoms(once)).toEqual(once);
  });
});

describe('built-in roles', () => {
  it('R2: the five roles form a strict superset chain, ascending', () => {
    for (let i = 1; i < BUILT_IN_ROLE_ORDER.length; i++) {
      const lower = BUILT_IN_ROLES[BUILT_IN_ROLE_ORDER[i - 1]!];
      const higher = BUILT_IN_ROLES[BUILT_IN_ROLE_ORDER[i]!];
      for (const atom of lower) {
        expect(higher.has(atom), `${BUILT_IN_ROLE_ORDER[i]!} must contain ${atom}`).toBe(true);
      }
      expect(higher.size).toBeGreaterThan(lower.size);
    }
  });

  it('neither toggle atom appears in any built-in role', () => {
    for (const role of BUILT_IN_ROLE_ORDER) {
      expect(BUILT_IN_ROLES[role].has('ai:use')).toBe(false);
      expect(BUILT_IN_ROLES[role].has('field:viewRestricted')).toBe(false);
    }
  });

  it('manager is the only role with sharing:manage', () => {
    const withSharing = BUILT_IN_ROLE_ORDER.filter((r) => BUILT_IN_ROLES[r].has('sharing:manage'));
    expect(withSharing).toEqual(['manager']);
  });

  it('every role can export, per decision 11', () => {
    for (const role of BUILT_IN_ROLE_ORDER) {
      expect(BUILT_IN_ROLES[role].has('export:run')).toBe(true);
    }
  });

  it('history:view starts at editor', () => {
    expect(BUILT_IN_ROLES.documenter.has('history:view')).toBe(false);
    expect(BUILT_IN_ROLES.editor.has('history:view')).toBe(true);
  });

  it('the five seeded ids are distinct and cuid-shaped', () => {
    const ids = Object.values(BUILTIN_ROLE_IDS);
    expect(new Set(ids).size).toBe(ids.length);
    // Lengths are NOT uniform on purpose — these mirror migration 0003 exactly.
    // apps/api/src/access/builtin-roles.spec.ts asserts that agreement.
    for (const id of ids) expect(id, id).toMatch(/^rl[0-9a-z]{20,24}$/);
  });
});

describe('normalizeRoleAtoms', () => {
  it('rejects unknown atoms rather than silently dropping them', () => {
    expect(() => normalizeRoleAtoms(['schema:view', 'schema:drop'])).toThrow(/schema:drop/);
  });

  it('applies the closure and sorts into PERMISSION_ATOMS order', () => {
    expect(normalizeRoleAtoms(['sharing:manage', 'docs:edit'])).toEqual([
      'schema:view',
      'docs:edit',
      'sharing:manage',
    ]);
  });

  it('is stable: normalizing twice changes nothing', () => {
    const once = normalizeRoleAtoms(['history:view', 'comment:create']);
    expect(normalizeRoleAtoms(once)).toEqual(once);
  });

  it('round-trips every built-in role unchanged', () => {
    for (const role of BUILT_IN_ROLE_ORDER) {
      const atoms = [...BUILT_IN_ROLES[role]] as PermissionAtom[];
      expect(new Set(normalizeRoleAtoms(atoms))).toEqual(BUILT_IN_ROLES[role]);
    }
  });
});
