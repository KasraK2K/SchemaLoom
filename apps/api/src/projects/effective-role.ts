import {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_ORDER,
  type AtomSet,
  type BuiltInResourceRole,
} from '@schemaloom/contracts';

/**
 * The label the sharing UI shows next to a project ("Editor", "Manager"). Derived from
 * the caller's PROJECT-scope atoms, never stored: the effective set is a union of org
 * role, group grants and user grants (doc 05 §7.4), so no single `access_grants` row
 * names it.
 *
 * Doc 05 §3.1 makes the five built-ins a strict chain, so "the highest role whose atoms
 * the caller holds" is well defined and reading downwards finds it in one pass. An org
 * owner holds all nine atoms (R13) and therefore reads as `manager`.
 *
 * `null` is a real answer, not a gap: the freelancer of §7.9 has no project-level grant
 * at all — every atom they hold is area- or entity-scoped — so they can open the project
 * with no project-wide role. The UI renders that as limited access, and a caller that
 * treats `null` as "no access" contradicts `canOpenProject`.
 */
const DESCENDING: readonly BuiltInResourceRole[] = [...BUILT_IN_ROLE_ORDER].reverse();

export function effectiveRole(atoms: AtomSet): BuiltInResourceRole | null {
  for (const role of DESCENDING) {
    let holdsAll = true;
    for (const atom of BUILT_IN_ROLES[role]) {
      if (!atoms.has(atom)) {
        holdsAll = false;
        break;
      }
    }
    if (holdsAll) return role;
  }
  return null;
}
