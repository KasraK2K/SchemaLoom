import { PERMISSION_ATOMS, closeAtoms, type PermissionAtom } from '@schemaloom/contracts';
import {
  principalKeyOf,
  type AccessEntry,
  type ContributingGrant,
  type ResourceNode,
} from './model';

/**
 * The client half of the inverse resolver (doc 05 §7.7). It answers the one question the
 * sharing dialog must answer BEFORE a write: what does this person hold at this resource
 * today, and what would they hold if I saved this grant?
 *
 * The server stays authoritative — it returns `warnings` on the write — but the footgun
 * has to be visible while the dropdown is still open, and §7.7 is explicit that a
 * per-keystroke resolve is the thing not to build. The payload already carries every
 * contributing grant with its level, so this is a set union over ~3 rows.
 */

export const ALL_ATOMS: ReadonlySet<PermissionAtom> = new Set(PERMISSION_ATOMS);

/** R13 — org OWNERS hold every atom, so nothing granted to them can change what they can
 *  do. Admins do not: they see only the projects they are granted. */
export function hasBlanketOrgAccess(entry: AccessEntry): boolean {
  return entry.orgRole === 'owner';
}

/**
 * `[entity, area?, project]` — nearest first, which is the order R15 resolves in.
 *
 * The walk is cycle-guarded because `resources` is a parsed network payload: a
 * `parentId` loop would otherwise spin forever inside a render.
 */
export function ancestorChain(
  resources: readonly ResourceNode[],
  ref: Pick<ResourceNode, 'id'>,
): ResourceNode[] {
  const byId = new Map(resources.map((node) => [node.id, node]));
  const chain: ResourceNode[] = [];
  const seen = new Set<string>();
  let current = byId.get(ref.id);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return chain;
}

/**
 * A grant's materialised atom set: the role's atoms plus whichever toggles are on,
 * closed under R1.
 *
 * ADDITIVE ONLY. The toggles are unioned in and there is no subtraction anywhere in this
 * function — which is why the dialog can render a role-implied toggle as
 * checked-and-disabled honestly: unchecking it would not have removed the atom.
 */
export function grantAtoms(
  grant: Pick<ContributingGrant, 'atoms' | 'canUseAi' | 'canViewRestricted'>,
): Set<PermissionAtom> {
  const atoms: PermissionAtom[] = [...grant.atoms];
  if (grant.canUseAi) atoms.push('ai:use');
  if (grant.canViewRestricted) atoms.push('field:viewRestricted');
  return closeAtoms(atoms);
}

/**
 * R15 — nearest-level-wins, evaluated PER PRINCIPAL.
 *
 * This is the whole footgun in four lines: a Viewer grant on an area is nearer than an
 * Editor grant on the project, so for that principal the area resolves to Viewer. It does
 * not touch any other principal, which is why a grant via a group survives a direct
 * narrowing grant and vice versa (E3/E5).
 *
 * Grants outside the chain are ignored, and two grants at the same level for one
 * principal are both returned so the caller can union them (R16).
 */
export function nearestGrants(
  grants: readonly ContributingGrant[],
  chain: readonly ResourceNode[],
): ContributingGrant[] {
  const depthOf = new Map(chain.map((node, index) => [node.id, index]));
  const best = new Map<string, { depth: number; grants: ContributingGrant[] }>();
  for (const grant of grants) {
    const depth = depthOf.get(grant.resourceId);
    if (depth === undefined) continue;
    const key = principalKeyOf(grant.principal);
    const hit = best.get(key);
    if (hit === undefined || depth < hit.depth) best.set(key, { depth, grants: [grant] });
    else if (depth === hit.depth) hit.grants.push(grant);
  }
  return [...best.values()].flatMap((entry) => entry.grants);
}

/** Effective atoms for one person at one resource: R13, then per-principal R15, then R16. */
export function effectiveAtomsAt(
  entry: AccessEntry,
  chain: readonly ResourceNode[],
): Set<PermissionAtom> {
  if (hasBlanketOrgAccess(entry)) return new Set(ALL_ATOMS);
  const out = new Set<PermissionAtom>();
  for (const grant of nearestGrants(entry.grants, chain)) {
    for (const atom of grantAtoms(grant)) out.add(atom);
  }
  return out;
}

/** The grant of the person's OWN principal that decides their access at this resource —
 *  the one a new direct grant would displace. */
export function decidingOwnGrant(
  entry: AccessEntry,
  chain: readonly ResourceNode[],
): ContributingGrant | undefined {
  const key = principalKeyOf(entry.principal);
  return nearestGrants(entry.grants, chain).find(
    (grant) => principalKeyOf(grant.principal) === key,
  );
}
