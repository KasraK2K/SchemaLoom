/**
 * The access module's public surface. Nothing outside `src/access/**` reads
 * `access_grants`, so this barrel is the whole contract other modules may use.
 */
export { AccessModule } from './access.module';
export {
  PermissionResolver,
  type AccessScope,
  type ProjectRow,
} from './permission-resolver.service';
export { PermissionGuard } from './permission.guard';
export {
  VisibilityFilter,
  isCompleteView,
  type QueryRow,
} from './visibility/visibility-filter.service';
export { ResourceIndex } from './resource-index';
export { getAccessContext, type AccessContext } from './access-context';
export {
  Authenticated,
  RequireOrgRole,
  RequirePermission,
  RequirePermissionAll,
  RequireProjectAccess,
  ROUTE_MARKER_KEYS,
  extract,
  markerKeysOn,
  readLocatorId,
  AUTHENTICATED_META,
  ORG_ROLE_META,
  PERM_META,
  PROJECT_ACCESS_META,
  type OrgRoleRequirement,
  type PermissionRequirement,
  type ResourceLocator,
} from './route-markers';
export { SHARE_LINK_ROUTES, isShareLinkRoute, routeKey } from './share-link-allowlist';
export { RouteSweep, assertRouteTable, type SweptRoute } from './route-sweep';
export { denialLine, logDenial, type DenialEvent, type DenialOutcome } from './denial-log';
export { assertAll, assertMayDeleteGrant, assertMayGrant } from './assertions';
export {
  ALL_ATOMS,
  EMPTY_ATOMS,
  SHARE_LINK_CEILING,
  intersect,
  materialise,
  sameSet,
  unionAll,
  withAtom,
  without,
} from './atoms';
export {
  PERM_TTL_MS,
  ancestorChain,
  atomsAt,
  canOpenProject,
  computeProjectMap,
  emptyMap,
  inheritedAtoms,
  nextExpiryOf,
  restrictedOkEntityIds,
  visibleEntityIds,
  type ComputeInput,
} from './resolve';
export {
  buildSkeleton,
  orgMemberKey,
  permMapKey,
  skeletonKey,
  type Generations,
} from './cache-keys';
export {
  principalKey,
  splitPrincipalKey,
  subjectKey,
  type AtomSet,
  type LiveGrant,
  type OrgRole,
  type PermissionAtom,
  type PrincipalKey,
  type PrincipalKind,
  type ProjectPermissionMap,
  type ProjectSkeleton,
  type ResourceRef,
  type RestrictedFieldMode,
  type SkeletonEntity,
  type Subject,
} from './types';
