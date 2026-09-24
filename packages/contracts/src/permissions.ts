import { z } from 'zod';

/**
 * The permission atom set. Fixed by C5 — nine atoms, and this tuple is the
 * single source of the vocabulary.
 *
 * Stored as `roles.atoms String[]`, NOT a PostgreSQL enum: `ALTER TYPE ... ADD
 * VALUE` cannot be used in the same transaction that seeds the new value, so a
 * migration adding an atom AND granting it to a role would have to split across
 * two deploys — and adding an atom is exactly what Phases 2-5 do. The write path
 * is the enforcement instead: `permissionAtomSchema` validates every element
 * before the array is stored.
 */
export const PERMISSION_ATOMS = [
  'schema:view',
  'schema:edit',
  'docs:edit',
  'comment:create',
  'ai:use',
  'export:run',
  'history:view',
  'sharing:manage',
  'field:viewRestricted',
] as const;

export const permissionAtomSchema = z.enum(PERMISSION_ATOMS);
export type PermissionAtom = (typeof PERMISSION_ATOMS)[number];
export type AtomSet = ReadonlySet<PermissionAtom>;

/**
 * R1 — the only implication: every atom implies `schema:view`. There is no
 * meaningful "edit docs but cannot see the schema".
 *
 * Applied ONCE at write time (when a Role row is saved, and when a grant is
 * materialised), which is what lets the resolver be a plain set union with zero
 * rule evaluation on the hot path.
 *
 * If a future atom needs a richer implication graph it goes in this function.
 * Deliberately not a rule engine: one line of real logic does not need one.
 */
export function closeAtoms(atoms: Iterable<PermissionAtom>): Set<PermissionAtom> {
  const s = new Set(atoms);
  if (s.size > 0) s.add('schema:view');
  return s;
}

/**
 * R2 — the five built-in resource roles form a totally ordered chain, each a
 * strict superset of the one below.
 *
 * This is a design constraint, not an accident: it makes "more specific grant
 * overrides broader" a well-defined strengthening or weakening rather than an
 * incomparable swap, and lets the Who-has-access UI sort roles on one axis.
 *
 * `ai:use` and `field:viewRestricted` are in NO built-in role. They are the two
 * per-grant toggles (`can_use_ai`, `can_view_restricted`) and are always an
 * explicit, deliberate addition — which is the entire point of the Restricted
 * flag. The toggles are ADDITIVE ONLY: a grant's effective atoms are
 * `role.atoms union {ai:use?} union {field:viewRestricted?}`, so a toggle can
 * add an atom and can never remove one.
 */
const VIEWER = ['schema:view', 'export:run'] as const;
const COMMENTER = [...VIEWER, 'comment:create'] as const;
const DOCUMENTER = [...COMMENTER, 'docs:edit'] as const;
const EDITOR = [...DOCUMENTER, 'schema:edit', 'history:view'] as const;
const MANAGER = [...EDITOR, 'sharing:manage'] as const;

/** Ascending. The index in this array IS the R2 order; nothing else defines it. */
export const BUILT_IN_ROLE_ORDER = [
  'viewer',
  'commenter',
  'documenter',
  'editor',
  'manager',
] as const;

export type BuiltInResourceRole = (typeof BUILT_IN_ROLE_ORDER)[number];

export const BUILT_IN_ROLES = {
  viewer: closeAtoms(VIEWER),
  commenter: closeAtoms(COMMENTER),
  documenter: closeAtoms(DOCUMENTER),
  editor: closeAtoms(EDITOR),
  manager: closeAtoms(MANAGER),
} satisfies Record<BuiltInResourceRole, Set<PermissionAtom>>;

/**
 * Fixed primary keys for the five built-in role rows, seeded by migration
 * `0003_builtin_roles`.
 *
 * PostgreSQL has no `cuid()` function, so generating them at insert time could
 * not be written as SQL at all; worse, ids that differ between dev, CI, staging
 * and production make seed data, fixtures and any exported grant set
 * non-portable, because `access_grants.role_id` is a real FK to them.
 *
 * They are cuid-SHAPED only — `access_grants_id_shape_ck` constrains
 * `principal_id`, not `role_id`, so nothing in the database validates them.
 * Their lengths are deliberately NOT uniform: these are the literal values
 * migration `0003_builtin_roles` seeds, and this constant must mirror that SQL
 * byte for byte. `access_grants.role_id` is a real FK to these rows, so a
 * "tidy-up" here that the migration does not match makes every
 * `findUnique({ id })` in the resolver miss.
 *
 * `apps/api/src/access/builtin-roles.spec.ts` parses the migration and asserts
 * the two agree. Do not edit one without the other.
 */
export const BUILTIN_ROLE_IDS = {
  viewer: 'rl00000000000000000viewer',
  commenter: 'rl0000000000000commenter',
  documenter: 'rl000000000000documenter',
  editor: 'rl00000000000000000editor',
  manager: 'rl0000000000000000manager',
} as const satisfies Record<BuiltInResourceRole, string>;

/** Org-level roles. Not atoms — see `@RequireOrgRole`. */
export const ORG_ROLES = ['owner', 'admin', 'member', 'guest'] as const;
export const orgRoleSchema = z.enum(ORG_ROLES);
export type OrgRole = (typeof ORG_ROLES)[number];

/** Grantable resource types (C5). Matches doc 02's `ResourceType` enum exactly. */
export const RESOURCE_TYPES = ['project', 'area', 'entity'] as const;
export const resourceTypeSchema = z.enum(RESOURCE_TYPES);
export type ResourceType = (typeof RESOURCE_TYPES)[number];

/** Grant principals (C5). Matches doc 02's `PrincipalType` enum exactly. */
export const PRINCIPAL_TYPES = ['user', 'group', 'email_invite', 'share_link'] as const;
export const principalTypeSchema = z.enum(PRINCIPAL_TYPES);
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/**
 * How a project renders restricted fields to someone without
 * `field:viewRestricted`. A real column on `projects`, not a settings-JSON key:
 * VisibilityFilter reads it on every request and it is security-relevant.
 */
export const RESTRICTED_FIELD_MODES = ['mask', 'hide'] as const;
export const restrictedFieldModeSchema = z.enum(RESTRICTED_FIELD_MODES);
export type RestrictedFieldMode = (typeof RESTRICTED_FIELD_MODES)[number];

/**
 * Validates a custom role's atom array on write: rejects unknown atoms, applies
 * the R1 closure, and sorts by `PERMISSION_ATOMS` order so stored arrays are
 * comparable and diffs are stable.
 */
export function normalizeRoleAtoms(input: readonly string[]): PermissionAtom[] {
  const unknown = input.filter((a) => !(PERMISSION_ATOMS as readonly string[]).includes(a));
  if (unknown.length > 0) {
    throw new Error(`Unknown permission atom(s): ${unknown.join(', ')}`);
  }
  return [...closeAtoms(input as readonly PermissionAtom[])].sort(
    (a, b) => PERMISSION_ATOMS.indexOf(a) - PERMISSION_ATOMS.indexOf(b),
  );
}
