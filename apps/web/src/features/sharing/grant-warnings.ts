import type { PermissionAtom } from '@schemaloom/contracts';
import {
  ancestorChain,
  decidingOwnGrant,
  effectiveAtomsAt,
  hasBlanketOrgAccess,
  nearestGrants,
} from './effective';
import {
  principalKeyOf,
  type AccessEntry,
  type ContributingGrant,
  type ResourceNode,
  type RoleOption,
  type ToggleAtom,
} from './model';

/**
 * The narrowing-grant warning — doc 05 §7.7 calls it the footgun, and it is the reason
 * the inverse resolver exists at all.
 *
 * R15 is per-principal nearest-level-wins, so giving someone Viewer on an area when they
 * already hold Editor on the project makes that area READ-ONLY for them. That is correct,
 * and it is the single most surprising thing this product does. A dialog that saves it
 * silently is a dialog that lies. So: compute it before the write, say it in a sentence
 * with the person's name and the two role names in it, and let them save anyway.
 */

export const INERT_ORG_ADMIN_LABEL = 'no effect — org admin';

export interface ProposedGrant {
  readonly target: ResourceNode;
  readonly role: RoleOption;
  readonly canUseAi: boolean;
  readonly canViewRestricted: boolean;
}

export type GrantWarning =
  | { readonly code: 'org_admin_inert'; readonly message: string }
  | { readonly code: 'narrows'; readonly message: string; readonly lost: PermissionAtom[] }
  /** §7.7's defeated grant: it changes nothing, usually because a group already covers
   *  it. `via` names the principals that defeat it. */
  | { readonly code: 'no_effect'; readonly message: string; readonly via: string[] };

/** How an atom reads in a sentence about losing it. */
const ATOM_LABELS: Readonly<Record<PermissionAtom, string>> = {
  'schema:view': 'viewing',
  'schema:edit': 'editing',
  'docs:edit': 'editing documentation',
  'comment:create': 'commenting',
  'ai:use': 'AI',
  'export:run': 'exporting',
  'history:view': 'history',
  'sharing:manage': 'sharing',
  'field:viewRestricted': 'restricted fields',
};

/** "a", "a and b", "a, b and c" */
function join(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;
}

/** The project is "this project"; everything else is called by its name. */
export function resourcePhrase(node: Pick<ResourceNode, 'type' | 'name'>): string {
  return node.type === 'project' ? 'this project' : node.name;
}

function grantPhrase(grant: ContributingGrant): string {
  return resourcePhrase({ type: grant.resourceType, name: grant.resourceName });
}

/**
 * R13 — a grant to an org owner or admin does nothing at all. Rendered struck through
 * rather than accepted silently: a manager who thinks they just downgraded the CTO to
 * Viewer has been told the opposite of the truth.
 */
export function isInertGrant(entry: AccessEntry): boolean {
  return hasBlanketOrgAccess(entry);
}

/** Replace this principal's own grant at the target with the proposed one. */
function withProposal(entry: AccessEntry, proposal: ProposedGrant): AccessEntry {
  const key = principalKeyOf(entry.principal);
  const kept = entry.grants.filter(
    (grant) =>
      principalKeyOf(grant.principal) !== key || grant.resourceId !== proposal.target.id,
  );
  const replacement: ContributingGrant = {
    id: '',
    principal: entry.principal,
    resourceType: proposal.target.type,
    resourceId: proposal.target.id,
    resourceName: proposal.target.name,
    roleKey: proposal.role.key,
    roleName: proposal.role.name,
    atoms: proposal.role.atoms,
    canUseAi: proposal.canUseAi,
    canViewRestricted: proposal.canViewRestricted,
    expiresAt: null,
  };
  return { ...entry, grants: [...kept, replacement] };
}

function narrowingMessage(
  entry: AccessEntry,
  proposal: ProposedGrant,
  displaced: ContributingGrant | undefined,
  lost: readonly PermissionAtom[],
): string {
  const who = entry.principal.label;
  const target = resourcePhrase(proposal.target);
  const consequence = lost.includes('schema:edit')
    ? `will make ${target} read-only for them`
    : `will remove ${join(lost.map((atom) => ATOM_LABELS[atom]))} in ${target} for them`;

  if (displaced === undefined) {
    return `Saving this ${consequence}.`;
  }
  const article = /^[aeiou]/i.test(displaced.roleName) ? 'an' : 'a';
  const held = `${who} is ${article} ${displaced.roleName} on ${grantPhrase(displaced)}.`;
  const action =
    displaced.resourceId === proposal.target.id
      ? `Changing them to ${proposal.role.name}`
      : `Giving them ${proposal.role.name} on ${target}`;
  return `${held} ${action} ${consequence}.`;
}

/**
 * Everything the dialog must say before it saves. Empty array means "just save it".
 *
 * Computed from the `?explain=1` payload the dialog already holds, not from a dry-run
 * request — §7.7 is explicit that a resolve per keystroke is the thing not to build, and
 * the server still returns the authoritative `warnings` on the write itself.
 */
export function previewGrant(
  entry: AccessEntry,
  resources: readonly ResourceNode[],
  proposal: ProposedGrant,
): GrantWarning[] {
  if (isInertGrant(entry)) {
    return [
      {
        code: 'org_admin_inert',
        message: `${entry.principal.label} is an org ${entry.orgRole ?? 'admin'} and already has full access to every project. This grant will have no effect.`,
      },
    ];
  }

  const chain = ancestorChain(resources, proposal.target);
  const before = effectiveAtomsAt(entry, chain);
  const after = effectiveAtomsAt(withProposal(entry, proposal), chain);
  const lost = [...before].filter((atom) => !after.has(atom));
  if (lost.length > 0) {
    return [
      {
        code: 'narrows',
        message: narrowingMessage(entry, proposal, decidingOwnGrant(entry, chain), lost),
        lost,
      },
    ];
  }

  const gained = [...after].filter((atom) => !before.has(atom));
  if (gained.length === 0) return [defeated(entry, proposal, chain)];
  return [];
}

/**
 * §7.7's *defeated* grant: it neither adds nor removes anything, and the usual reason is
 * that another principal — a group — already covers it. Naming that principal is the
 * difference between "nothing happened" and "narrow the group too".
 */
function defeated(
  entry: AccessEntry,
  proposal: ProposedGrant,
  chain: readonly ResourceNode[],
): GrantWarning {
  const ownKey = principalKeyOf(entry.principal);
  const others = nearestGrants(entry.grants, chain).filter(
    (grant) => principalKeyOf(grant.principal) !== ownKey,
  );
  const via = others.map((grant) =>
    grant.principal.kind === 'group'
      ? `the group ${grant.principal.label}`
      : grant.principal.label,
  );
  const where = resourcePhrase(proposal.target);
  const widest = others[0];
  return {
    code: 'no_effect',
    via,
    message:
      widest === undefined
        ? `${entry.principal.label} already has this access on ${where}. Saving changes nothing.`
        : `${entry.principal.label} is still ${/^[aeiou]/i.test(widest.roleName) ? 'an' : 'a'} ${widest.roleName} on ${where} via ${join(via)}. This grant will not narrow that.`,
  };
}

export interface ToggleState {
  readonly checked: boolean;
  readonly disabled: boolean;
  /** Why it cannot be unchecked, or `null` when it can. */
  readonly note: string | null;
}

/**
 * The two per-grant toggles are ADDITIVE ONLY — `grantAtoms` unions them in and never
 * subtracts. So a role that already carries the atom cannot have it toggled off, and
 * rendering an unchecked, enabled box there would be a lie a manager acts on. Checked and
 * disabled, with the reason, instead.
 */
export function toggleState(role: RoleOption, atom: ToggleAtom, on: boolean): ToggleState {
  return role.atoms.includes(atom)
    ? { checked: true, disabled: true, note: `always included in ${role.name}` }
    : { checked: on, disabled: false, note: null };
}
