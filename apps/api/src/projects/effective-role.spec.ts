import { BUILT_IN_ROLES, PERMISSION_ATOMS, type PermissionAtom } from '@schemaloom/contracts';
import { describe, expect, it } from 'vitest';
import { effectiveRole } from './effective-role';

const setOf = (...atoms: PermissionAtom[]): ReadonlySet<PermissionAtom> => new Set(atoms);

describe('effectiveRole', () => {
  it('names each built-in role from exactly its own atoms', () => {
    for (const [role, atoms] of Object.entries(BUILT_IN_ROLES)) {
      expect(effectiveRole(atoms)).toBe(role);
    }
  });

  it('reads an org owner/admin (all nine atoms, R13) as manager', () => {
    expect(effectiveRole(new Set(PERMISSION_ATOMS))).toBe('manager');
  });

  it('returns null for a project-level-empty map, not a thrown error', () => {
    // Doc 05 §7.9's freelancer: every atom they hold is area-scoped, so they can open the
    // project with no project-wide role. `null` is the answer, and a caller that reads it
    // as "no access" contradicts `canOpenProject`.
    expect(effectiveRole(setOf())).toBeNull();
  });

  it('does not round a partial set UP to the next role in the chain', () => {
    // `schema:edit` without the rest of editor's closure must not read as "editor".
    const partial = setOf('schema:view', 'schema:edit');
    const role = effectiveRole(partial);
    if (role !== null) {
      for (const atom of BUILT_IN_ROLES[role]) expect(partial.has(atom)).toBe(true);
    }
  });
});
