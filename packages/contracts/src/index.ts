/**
 * @schemaloom/contracts — shared transport vocabulary: zod schemas, DTO types,
 * permission enums.
 *
 * C10: depends on `schema-model` (domain) and zod. Nothing depends on this
 * except the two apps, so an HTTP concern added here can never leak into
 * `engine-sdk`'s closure.
 *
 * Phase 1 build order: step 3 is the permission vocabulary below. Request and
 * response schemas arrive with the routes that need them (steps 8-14).
 */
export {
  BUILT_IN_ROLES,
  BUILT_IN_ROLE_ORDER,
  BUILTIN_ROLE_IDS,
  ORG_ROLES,
  PERMISSION_ATOMS,
  PRINCIPAL_TYPES,
  RESOURCE_TYPES,
  RESTRICTED_FIELD_MODES,
  closeAtoms,
  normalizeRoleAtoms,
  orgRoleSchema,
  permissionAtomSchema,
  principalTypeSchema,
  resourceTypeSchema,
  restrictedFieldModeSchema,
  type AtomSet,
  type BuiltInResourceRole,
  type OrgRole,
  type PermissionAtom,
  type PrincipalType,
  type ResourceType,
  type RestrictedFieldMode,
} from './permissions.js';

export {
  NOTIFICATION_TYPES,
  notificationTypeSchema,
  type NotificationType,
} from './notifications.js';

/**
 * Re-exported from `schema-model`, which owns it (C10 forbids the reverse
 * dependency). The API layer imports it from here so there is one import site
 * for transport-adjacent constants.
 */
export { MAX_FIELD_DEPTH } from '@schemaloom/schema-model';
