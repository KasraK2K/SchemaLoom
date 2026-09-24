import { PERMISSION_ATOMS, type AtomSet, type PermissionAtom } from '@schemaloom/contracts';

/**
 * Doc 05 §7.5 — the set algebra the whole resolver is built out of. Unions and
 * intersections only, which is what makes R18 (determinism) true by construction: there
 * is no operation here whose result depends on the order of its inputs.
 */

export const EMPTY_ATOMS: AtomSet = new Set<PermissionAtom>();

/** R13 — what an org owner or admin holds on every resource in the org. */
export const ALL_ATOMS: AtomSet = new Set<PermissionAtom>(PERMISSION_ATOMS);

/**
 * R17 — a share-link subject is intersected with this, last, whatever role the link's
 * grant carries. A fixed, code-level cap; never data.
 */
export const SHARE_LINK_CEILING: AtomSet = new Set<PermissionAtom>(['schema:view']);

const KNOWN_ATOMS: ReadonlySet<string> = new Set<string>(PERMISSION_ATOMS);

export const withAtom = (s: AtomSet, a: PermissionAtom): AtomSet =>
  s.has(a) ? s : new Set([...s, a]);

export const without = (s: AtomSet, a: PermissionAtom): AtomSet =>
  s.has(a) ? new Set([...s].filter((x) => x !== a)) : s;

export const intersect = (s: AtomSet, t: AtomSet): AtomSet =>
  new Set([...s].filter((a) => t.has(a)));

export const unionAll = (sets: readonly AtomSet[]): AtomSet =>
  new Set(sets.flatMap((s) => [...s]));

export const sameSet = (s: AtomSet, t: AtomSet): boolean =>
  s.size === t.size && [...s].every((a) => t.has(a));

/** For each key, union that key's set across every per-principal map. Missing = empty. */
export function unionByKey(
  maps: readonly ReadonlyMap<string, AtomSet>[],
  keys: readonly string[],
): Map<string, AtomSet> {
  return new Map(keys.map((k) => [k, unionAll(maps.map((m) => m.get(k) ?? EMPTY_ATOMS))]));
}

export function intersectAllInPlace(m: Map<string, AtomSet>, ceiling: AtomSet): void {
  for (const [k, v] of m) m.set(k, intersect(v, ceiling));
}

export function withoutAllInPlace(m: Map<string, AtomSet>, a: PermissionAtom): void {
  for (const [k, v] of m) m.set(k, without(v, a));
}

/**
 * R7 — the grant modifier booleans are ADDITIVE ONLY. `role.atoms` was already closed
 * under R1 at write time, so the union needs no re-closure: every atom implies
 * `schema:view`, and both modifiers are atoms of a non-empty set.
 *
 * `roles.atoms` is `String[]` in Postgres, not an enum array (adding an atom must not
 * need two deploys), so an unrecognised element is possible — from a rolled-back deploy,
 * a hand-edited row, a future atom this build does not know. It is DROPPED. An atom this
 * code cannot name is an atom it cannot enforce, and silently carrying it through would
 * let a future `ai:use`-shaped string satisfy nothing while looking like authority.
 */
export function materialise(g: {
  readonly atoms: readonly string[];
  readonly canUseAi: boolean;
  readonly canViewRestricted: boolean;
}): AtomSet {
  const atoms = new Set<PermissionAtom>(
    g.atoms.filter((a): a is PermissionAtom => KNOWN_ATOMS.has(a)),
  );
  if (g.canUseAi) atoms.add('ai:use');
  if (g.canViewRestricted) atoms.add('field:viewRestricted');
  return atoms;
}
