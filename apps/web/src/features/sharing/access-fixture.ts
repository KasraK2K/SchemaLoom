import { BUILT_IN_ROLES, BUILT_IN_ROLE_ORDER, type PermissionAtom } from '@schemaloom/contracts';
import type {
  AccessEntry,
  ContributingGrant,
  PrincipalRef,
  ResourceNode,
  RoleOption,
} from './model';

/**
 * The world the sharing specs reason about: a project with one area ("Billing") holding
 * one entity, and Ana, who is an Editor on the project.
 *
 * It is the §7.7 example verbatim, because that is the case the whole feature exists for.
 */
export const PROJECT: ResourceNode = {
  type: 'project',
  id: 'prj_1',
  name: 'Acme',
  parentId: null,
};
export const BILLING: ResourceNode = {
  type: 'area',
  id: 'area_billing',
  name: 'Billing',
  parentId: PROJECT.id,
};
export const INVOICES: ResourceNode = {
  type: 'entity',
  id: 'ent_invoices',
  name: 'invoices',
  parentId: BILLING.id,
};

export const RESOURCES: readonly ResourceNode[] = [PROJECT, BILLING, INVOICES];

export const ROLES: readonly RoleOption[] = BUILT_IN_ROLE_ORDER.map((key) => ({
  key,
  name: key.charAt(0).toUpperCase() + key.slice(1),
  atoms: [...BUILT_IN_ROLES[key]],
  builtIn: true,
}));

export function role(key: string): RoleOption {
  const found = ROLES.find((option) => option.key === key);
  if (found === undefined) throw new Error(`no such role: ${key}`);
  return found;
}

/** A custom role that already carries a toggle atom — the implied-toggle case. */
export function customRole(name: string, atoms: readonly PermissionAtom[]): RoleOption {
  return { key: `custom_${name}`, name, atoms: [...atoms], builtIn: false };
}

export const ANA: PrincipalRef = { kind: 'user', id: 'usr_ana', label: 'Ana' };
export const ANALYSTS: PrincipalRef = { kind: 'group', id: 'grp_analysts', label: 'Analysts' };

export function grant(
  principal: PrincipalRef,
  resource: ResourceNode,
  roleKey: string,
  overrides: Partial<Pick<ContributingGrant, 'canUseAi' | 'canViewRestricted'>> = {},
): ContributingGrant {
  const option = role(roleKey);
  return {
    id: `gr_${principal.id}_${resource.id}`,
    principal,
    resourceType: resource.type,
    resourceId: resource.id,
    resourceName: resource.name,
    roleKey: option.key,
    roleName: option.name,
    atoms: option.atoms,
    canUseAi: overrides.canUseAi ?? false,
    canViewRestricted: overrides.canViewRestricted ?? false,
    expiresAt: null,
  };
}

export function entry(
  principal: PrincipalRef,
  grants: readonly ContributingGrant[],
  overrides: Partial<Pick<AccessEntry, 'orgRole' | 'email'>> = {},
): AccessEntry {
  return {
    principal,
    orgRole: overrides.orgRole ?? 'member',
    email: overrides.email ?? `${principal.id}@example.com`,
    grants: [...grants],
  };
}

/** Ana, Editor on the project. The starting point of the footgun. */
export function anaEditorOnProject(): AccessEntry {
  return entry(ANA, [grant(ANA, PROJECT, 'editor')]);
}
