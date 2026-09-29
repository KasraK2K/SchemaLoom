import type { AtomSet, OrgRole, PermissionAtom, RestrictedFieldMode } from '@schemaloom/contracts';
import { PERMISSION_MAP_TTL_CAP_SEC } from '../redis/ttl';
import {
  ALL_ATOMS,
  EMPTY_ATOMS,
  SHARE_LINK_CEILING,
  intersect,
  intersectAllInPlace,
  materialise,
  sameSet,
  unionAll,
  unionByKey,
  withAtom,
  without,
  withoutAllInPlace,
} from './atoms';
import type {
  DroppedGrantReason,
  LiveGrant,
  PrincipalKey,
  ProjectPermissionMap,
  ProjectSkeleton,
  ResourceRef,
  SkeletonEntity,
  Subject,
} from './types';
import { subjectKey } from './types';

/**
 * Doc 05 §7.4-§7.5 — the rules, as one pure function of
 * `(org role, group memberships, live grants, skeleton, restrictedFieldMode, now)`.
 *
 * **Nothing in this file does I/O.** That is the point: R13-R18 are unit-testable as a
 * matrix without a database, and the service above is only cache plumbing. Every rule
 * below is a union or an intersection, so the result is order-independent (R18).
 */

/** §9.1 — the cap on a permission map's own lifetime. */
export const PERM_TTL_MS = PERMISSION_MAP_TTL_CAP_SEC * 1000;

// ---------------------------------------------------------------------------------------
// Derived accessors — everything outside `ProjectPermissionMap` is computed, not stored.
// ---------------------------------------------------------------------------------------

export function inheritedAtoms(map: ProjectPermissionMap, e: SkeletonEntity): AtomSet {
  return e.areaId === null ? map.projectAtoms : (map.areaAtoms.get(e.areaId) ?? EMPTY_ATOMS);
}

/** §7.5. Effective atoms at one resource. Pure; no I/O. */
export function atomsAt(
  map: ProjectPermissionMap,
  skel: ProjectSkeleton,
  ref: ResourceRef,
): AtomSet {
  if (ref.type === 'project') return ref.id === map.projectId ? map.projectAtoms : EMPTY_ATOMS;
  if (ref.type === 'area') return map.areaAtoms.get(ref.id) ?? EMPTY_ATOMS;
  const e = skel.entityById.get(ref.id);
  if (!e) return EMPTY_ATOMS; // unknown id -> 404 upstream
  return map.entityOverrides.get(ref.id) ?? inheritedAtoms(map, e);
}

function entityIdsWith(
  map: ProjectPermissionMap,
  skel: ProjectSkeleton,
  atom: PermissionAtom,
): Set<string> {
  const out = new Set<string>();
  for (const e of skel.entities) {
    if ((map.entityOverrides.get(e.id) ?? inheritedAtoms(map, e)).has(atom)) out.add(e.id);
  }
  return out;
}

export const visibleEntityIds = (map: ProjectPermissionMap, skel: ProjectSkeleton): Set<string> =>
  entityIdsWith(map, skel, 'schema:view');

/**
 * §7.10 — per ENTITY, not per subject: the same user can hold `field:viewRestricted` on
 * the Billing area and not on the rest of the project.
 */
export const restrictedOkEntityIds = (
  map: ProjectPermissionMap,
  skel: ProjectSkeleton,
): Set<string> => entityIdsWith(map, skel, 'field:viewRestricted');

/**
 * §7.9 — a derived boolean, not a tenth atom. The freelancer with only an area grant has
 * no project-level `schema:view` and must still be able to open the project.
 *
 * Derivable from the map alone, with no skeleton, so `GET /projects` does not pay for one
 * skeleton per candidate project.
 */
export function canOpenProject(map: ProjectPermissionMap): boolean {
  if (map.projectAtoms.size > 0) return true;
  for (const s of map.areaAtoms.values()) if (s.size > 0) return true;
  for (const s of map.entityOverrides.values()) if (s.size > 0) return true;
  return false;
}

/** §7.2 — ancestry, most specific first. Organization and workspace are not in the chain. */
export function ancestorChain(
  projectId: string,
  ref: ResourceRef,
  skel: ProjectSkeleton,
): ResourceRef[] {
  if (ref.type === 'project') return [{ type: 'project', id: projectId }];
  if (ref.type === 'area') {
    return [
      { type: 'area', id: ref.id },
      { type: 'project', id: projectId },
    ];
  }
  const areaId = skel.entityById.get(ref.id)?.areaId ?? null;
  return areaId === null
    ? [
        { type: 'entity', id: ref.id },
        { type: 'project', id: projectId },
      ]
    : [
        { type: 'entity', id: ref.id },
        { type: 'area', id: areaId },
        { type: 'project', id: projectId },
      ];
}

// ---------------------------------------------------------------------------------------
// §7.15 — integrity of the polymorphic pointer, bought back inside the index step.
// ---------------------------------------------------------------------------------------

export interface PrincipalGrants {
  /** Materialised atoms of this principal's project-level grant, if any. */
  project?: AtomSet;
  readonly area: Map<string, AtomSet>;
  readonly entity: Map<string, AtomSet>;
}

/**
 * §7.15. `AccessGrant.resourceId` is polymorphic with no foreign key (doc 02's deliberate
 * choice), so this is the application-side alarm for a row that predates a constraint or
 * arrived by backfill. A dangling row is DROPPED, never resolved.
 *
 * Grants are materialised here rather than carried as rows, so that a duplicate at one
 * level — which R10's unique index forbids and which therefore means the index is gone —
 * unions instead of last-write-wins. That keeps R18 true even against impossible data.
 */
export function indexGrants(
  grants: readonly LiveGrant[],
  projectId: string,
  skel: ProjectSkeleton,
  onDropped?: (reason: DroppedGrantReason, grant: LiveGrant) => void,
): Map<PrincipalKey, PrincipalGrants> {
  const areaIds = new Set(skel.areaIds);
  const out = new Map<PrincipalKey, PrincipalGrants>();

  for (const g of grants) {
    if (g.resourceType === 'project' && g.resourceId !== projectId) {
      onDropped?.('grant_project_mismatch', g);
      continue;
    }
    if (g.resourceType === 'area' && !areaIds.has(g.resourceId)) {
      onDropped?.('grant_dangling_area', g);
      continue;
    }
    if (g.resourceType === 'entity' && !skel.entityById.has(g.resourceId)) {
      onDropped?.('grant_dangling_entity', g);
      continue;
    }

    let slot = out.get(g.principalKey);
    if (!slot) {
      slot = { area: new Map(), entity: new Map() };
      out.set(g.principalKey, slot);
    }
    const atoms = materialise(g);
    if (g.resourceType === 'project') {
      slot.project = slot.project ? unionAll([slot.project, atoms]) : atoms;
    } else {
      const level = g.resourceType === 'area' ? slot.area : slot.entity;
      const existing = level.get(g.resourceId);
      level.set(g.resourceId, existing ? unionAll([existing, atoms]) : atoms);
    }
  }
  return out;
}

/**
 * R12.1 + share-link expiry — BOTH. A link expiring in 30 s must not leave a 300 s map
 * behind it (§7.12), which is why the hot query selects `share_links.expires_at` at all.
 */
export function nextExpiryOf(grants: readonly LiveGrant[]): number | null {
  let min: number | null = null;
  for (const g of grants) {
    for (const d of [g.expiresAt, g.linkExpiresAt]) {
      if (!d) continue;
      const t = d.getTime();
      if (min === null || t < min) min = t;
    }
  }
  return min;
}

// ---------------------------------------------------------------------------------------
// The three map shapes.
// ---------------------------------------------------------------------------------------

/** R13 — the org owner short-circuit. Grants are not read at all. Admins go through grants. */
export function allAccessMap(
  projectId: string,
  skel: ProjectSkeleton,
  subject: Subject,
  orgRole: OrgRole,
  restrictedFieldMode: RestrictedFieldMode,
  nowMs: number,
): ProjectPermissionMap {
  return {
    projectId,
    subjectKey: subjectKey(subject),
    orgRole,
    projectAtoms: ALL_ATOMS,
    areaAtoms: new Map(skel.areaIds.map((a) => [a, ALL_ATOMS])),
    entityOverrides: new Map(), // nothing differs from the inherited value
    restrictedFieldMode,
    validUntil: nowMs + PERM_TTL_MS,
  };
}

/** Never cached: a nonexistent or unreachable project has no row to key it by. */
export function emptyMap(projectId: string, subject: Subject): ProjectPermissionMap {
  return {
    projectId,
    subjectKey: subjectKey(subject),
    orgRole: null,
    projectAtoms: EMPTY_ATOMS,
    areaAtoms: new Map(),
    entityOverrides: new Map(),
    restrictedFieldMode: 'mask', // default; nothing is visible anyway
    validUntil: 0,
  };
}

// ---------------------------------------------------------------------------------------
// §7.5 steps 3-7 — the rule evaluation itself.
// ---------------------------------------------------------------------------------------

export interface ComputeInput {
  readonly projectId: string;
  readonly subject: Subject;
  /** null for a share-link subject. Never `owner`: R13 short-circuits earlier. */
  readonly orgRole: OrgRole | null;
  readonly principals: readonly PrincipalKey[];
  readonly grants: readonly LiveGrant[];
  readonly skeleton: ProjectSkeleton;
  readonly restrictedFieldMode: RestrictedFieldMode;
  readonly nowMs: number;
  readonly onDroppedGrant?: (reason: DroppedGrantReason, grant: LiveGrant) => void;
}

interface Cascade {
  readonly project: AtomSet;
  readonly area: Map<string, AtomSet>;
  readonly entity: Map<string, AtomSet>;
}

/**
 * R15 — per-principal NEAREST-LEVEL-WINS. For ONE principal, walk entity -> area ->
 * project and stop at the first level carrying a live grant; that level decides this
 * principal's contribution ENTIRELY. Broader levels are discarded, not unioned.
 *
 * Expressed here as a downward fill rather than an upward walk, which is the same thing
 * evaluated once per level instead of once per (entity, level) pair.
 */
function cascadeFor(g: PrincipalGrants, skel: ProjectSkeleton): Cascade {
  const pProject = g.project ?? EMPTY_ATOMS;

  const pArea = new Map<string, AtomSet>();
  for (const areaId of skel.areaIds) {
    pArea.set(areaId, g.area.get(areaId) ?? pProject);
  }

  const pEntity = new Map<string, AtomSet>();
  for (const e of skel.entities) {
    const own = g.entity.get(e.id);
    if (own) {
      pEntity.set(e.id, own); // nearest level = entity
      continue;
    }
    // §7.11 — an entity in no area (or whose areaId dangles) inherits straight from the
    // project; the area level is simply absent from its chain.
    const fromArea = e.areaId === null ? undefined : pArea.get(e.areaId);
    pEntity.set(e.id, fromArea ?? pProject);
  }

  // ---- step 4b: R5 — union `sharing:manage` DOWNWARD from wherever it is held ----------
  // This is what makes `atomsAt(...).has('sharing:manage')` mean the ancestor-OR of R5,
  // so the guard and R4 need no special case. Lemma (§4.2): it can never introduce
  // `schema:view` where the chain had none, because every receiving set is either a
  // stored role (non-empty and R1-closed) or a copy of a non-empty ancestor set.
  if (pProject.has('sharing:manage')) {
    for (const [k, v] of pArea) pArea.set(k, withAtom(v, 'sharing:manage'));
    for (const [k, v] of pEntity) pEntity.set(k, withAtom(v, 'sharing:manage'));
  } else {
    // R6 — never upward or sideways: only entities under an area that holds it.
    for (const e of skel.entities) {
      const areaAtoms = e.areaId === null ? undefined : pArea.get(e.areaId);
      if (!areaAtoms?.has('sharing:manage')) continue;
      const own = pEntity.get(e.id);
      if (own) pEntity.set(e.id, withAtom(own, 'sharing:manage'));
    }
  }

  return { project: pProject, area: pArea, entity: pEntity };
}

export function computeProjectMap(input: ComputeInput): ProjectPermissionMap {
  const { skeleton: skel, subject, nowMs } = input;

  // ---- step 3: index by principal and level; §7.15 drops bad rows here -----------------
  const byPrincipal = indexGrants(input.grants, input.projectId, skel, input.onDroppedGrant);

  // ---- step 4: per-principal cascade (R15) --------------------------------------------
  const perPrincipal: Cascade[] = [];
  for (const p of input.principals) {
    const g = byPrincipal.get(p);
    if (!g) continue; // this principal contributes nothing
    perPrincipal.push(cascadeFor(g, skel));
  }

  // ---- step 5: union across principals (R16) ------------------------------------------
  // The deciding level was computed PER PRINCIPAL, so a group's narrow entity grant can
  // never demote a broader personal grant (E5). Adding a principal or a grant is
  // monotone: it can only add atoms, never remove them.
  let projectAtoms = unionAll(perPrincipal.map((x) => x.project));
  const areaAtoms = unionByKey(
    perPrincipal.map((x) => x.area),
    skel.areaIds,
  );
  const entityAll = unionByKey(
    perPrincipal.map((x) => x.entity),
    skel.entities.map((e) => e.id),
  );

  // ---- step 6: ceilings (R17) — the ONLY cap, applied last and not data-driven ---------
  if (subject.kind === 'share_link') {
    projectAtoms = intersect(projectAtoms, SHARE_LINK_CEILING);
    intersectAllInPlace(areaAtoms, SHARE_LINK_CEILING);
    intersectAllInPlace(entityAll, SHARE_LINK_CEILING);
  } else if (input.orgRole === 'guest') {
    projectAtoms = without(projectAtoms, 'sharing:manage'); // R9
    withoutAllInPlace(areaAtoms, 'sharing:manage');
    withoutAllInPlace(entityAll, 'sharing:manage');
  }

  // ---- step 7: keep only the entities that differ from what they inherit ---------------
  const entityOverrides = new Map<string, AtomSet>();
  for (const e of skel.entities) {
    const mine = entityAll.get(e.id) ?? EMPTY_ATOMS;
    const inherited =
      e.areaId === null ? projectAtoms : (areaAtoms.get(e.areaId) ?? EMPTY_ATOMS);
    if (!sameSet(mine, inherited)) entityOverrides.set(e.id, mine);
  }

  const nextExpiry = nextExpiryOf(input.grants);
  return {
    projectId: input.projectId,
    subjectKey: subjectKey(subject),
    orgRole: input.orgRole,
    projectAtoms,
    areaAtoms,
    entityOverrides,
    restrictedFieldMode: input.restrictedFieldMode,
    validUntil: Math.min(nowMs + PERM_TTL_MS, nextExpiry ?? Number.POSITIVE_INFINITY),
  };
}
