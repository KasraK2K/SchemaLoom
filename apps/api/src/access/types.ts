import type { AtomSet, OrgRole, PermissionAtom, RestrictedFieldMode } from '@schemaloom/contracts';

/**
 * Doc 05 §7.0-§7.2 — the vocabulary the resolver is written in. Types only; every
 * function that touches them lives in `atoms.ts` (set algebra) or `resolve.ts` (rules).
 */

/**
 * §6.4 / R11 — `email_invite` principals never reach the resolver: a pending invite has
 * no session to attach to. The resolver reads exactly these three.
 */
export type PrincipalKind = 'user' | 'group' | 'share_link';

/** `user:<id>` | `group:<id>` | `share_link:<id>` — the key of every per-principal map. */
export type PrincipalKey = `${PrincipalKind}:${string}`;

export function principalKey(kind: PrincipalKind, id: string): PrincipalKey {
  return `${kind}:${id}`;
}

/** The inverse. Ids are cuids, so the first `:` is unambiguous. */
export function splitPrincipalKey(key: PrincipalKey): { kind: PrincipalKind; id: string } {
  const at = key.indexOf(':');
  return { kind: key.slice(0, at) as PrincipalKind, id: key.slice(at + 1) };
}

/**
 * §7.1. No `guest` kind (guest is an org role) and no `group` kind (group membership is a
 * set expanded inside the resolver).
 */
export type Subject =
  | { kind: 'user'; userId: string; orgId: string }
  | { kind: 'share_link'; shareLinkId: string; projectId: string };

/** §9.1 — the `{subjectKey}` segment of the permission-map cache key. */
export function subjectKey(s: Subject): string {
  return s.kind === 'user' ? `u:${s.userId}` : `sl:${s.shareLinkId}`;
}

/**
 * §7.2. Organization, workspace, namespace and field are deliberately NOT here:
 * org role is applied before grants (R13), workspaces are a listing container (C5),
 * namespaces are not user-facing grouping, and field visibility is a function of the
 * field's entity plus `isRestricted` (§7.10).
 */
export type ResourceRef =
  | { type: 'project'; id: string }
  | { type: 'area'; id: string }
  | { type: 'entity'; id: string };

/** One row of the hot query (§7.5), already joined to its role. */
export interface LiveGrant {
  readonly id: string;
  readonly resourceType: 'project' | 'area' | 'entity';
  readonly resourceId: string;
  readonly principalKey: PrincipalKey;
  /** `roles.atoms`. Stored as `String[]`, so unknown values are possible and are dropped. */
  readonly atoms: readonly string[];
  readonly canUseAi: boolean;
  readonly canViewRestricted: boolean;
  readonly expiresAt: Date | null;
  /** `share_links.expires_at`; null for every other principal kind. */
  readonly linkExpiresAt: Date | null;
}

export interface SkeletonEntity {
  readonly id: string;
  readonly areaId: string | null;
}

/**
 * §7.5 — subject-independent, shared across every user of the project, cached for 600 s
 * under the project generation alone.
 */
export interface ProjectSkeleton {
  /** `Project.permGeneration` when built. Part of the cache key, kept for debugging. */
  readonly generation: number;
  readonly areaIds: readonly string[];
  readonly entities: readonly SkeletonEntity[];
  readonly entityById: ReadonlyMap<string, SkeletonEntity>;
  /** R21' and §8.3 ask "which entities have a restricted field", never "which field ids". */
  readonly entitiesWithRestrictedFields: ReadonlySet<string>;
}

/**
 * §7.5 — one subject's whole view of one project.
 *
 * `entityOverrides` holds ONLY the entities whose atoms differ from what they inherit.
 * On a 300-entity project where every entity resolves to the same nine strings that is an
 * empty map (~2 KB of Redis) instead of 300 identical entries (~50 KB). Everything else
 * is derived by `atomsAt`, so there is one shape and nothing to keep in sync.
 */
export interface ProjectPermissionMap {
  readonly projectId: string;
  readonly subjectKey: string;
  /** null for a share-link subject. */
  readonly orgRole: OrgRole | null;
  readonly projectAtoms: AtomSet;
  readonly areaAtoms: ReadonlyMap<string, AtomSet>;
  readonly entityOverrides: ReadonlyMap<string, AtomSet>;
  readonly restrictedFieldMode: RestrictedFieldMode;
  /** Wall-clock ms. `min(now + PERM_TTL_MS, next grant OR share-link expiry)`. */
  readonly validUntil: number;
}

/** §7.15 — why `indexGrants` threw a row away. Each one means a delete path is missing. */
export type DroppedGrantReason =
  | 'grant_project_mismatch'
  | 'grant_dangling_area'
  | 'grant_dangling_entity';

export type { AtomSet, OrgRole, PermissionAtom, RestrictedFieldMode };
