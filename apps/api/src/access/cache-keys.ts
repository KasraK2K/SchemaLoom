import {
  ORG_ROLES,
  PERMISSION_ATOMS,
  RESTRICTED_FIELD_MODES,
  type AtomSet,
  type OrgRole,
  type PermissionAtom,
  type RestrictedFieldMode,
} from '@schemaloom/contracts';
import type { ProjectPermissionMap, ProjectSkeleton, SkeletonEntity } from './types';

/**
 * Doc 05 §9.1 — the three cached shapes, their keys and their serialisation.
 *
 * **The keys here are UNPREFIXED on purpose.** `REDIS_KEY_PREFIX` and the `cache:`
 * client namespace are applied by ioredis' own `keyPrefix` on the `REDIS_CACHE` client
 * (`redis.factory.ts`), so the key that actually lands in Redis is
 * `${REDIS_KEY_PREFIX}cache:perm:3:…`. Writing the prefix here too would double it.
 *
 * The `3` is a schema version for the cached SHAPE. Bumping it invalidates every entry on
 * deploy, which is exactly what you want when the map changes — and this revision earned
 * it once already, when `entityOverrides` replaced `entityAtoms`.
 */
export const PERM_CACHE_VERSION = 3;

/** §9.1 — the three generation counters, read from Postgres on every resolve (§9.2). */
export interface Generations {
  /** `Organization.permGeneration` */
  readonly og: number;
  /** `Project.permGeneration` */
  readonly pg: number;
  /** `User.permGeneration`; 0 for a share-link subject, which has no user-scoped state. */
  readonly sg: number;
}

export const permMapKey = (projectId: string, subject: string, g: Generations): string =>
  `perm:${String(PERM_CACHE_VERSION)}:${projectId}:${subject}:${String(g.og)}.${String(g.pg)}.${String(g.sg)}`;

/**
 * Keyed by the project generation ALONE, because entity create/delete, entity `areaId`
 * and area create/delete are the only writes that change what the skeleton says — and
 * they are exactly what bumps `pg` (§9.3).
 */
export const skeletonKey = (projectId: string, pg: number): string =>
  `skel:${String(PERM_CACHE_VERSION)}:${projectId}:${String(pg)}`;

export const orgMemberKey = (orgId: string, userId: string, g: Generations): string =>
  `orgmem:${String(PERM_CACHE_VERSION)}:${orgId}:${userId}:${String(g.og)}.${String(g.sg)}`;

// ---------------------------------------------------------------------------------------
// Serialisation. Sets and Maps do not survive JSON, so the wire shape is explicit.
//
// Every parse is TOTAL: anything unexpected returns null and the caller recomputes from
// Postgres. A corrupt or foreign cache entry must degrade to a cache miss, never to a
// permission map assembled out of whatever was in the string — which is also why atoms
// are filtered against PERMISSION_ATOMS on the way in rather than cast.
// ---------------------------------------------------------------------------------------

const KNOWN_ATOMS: ReadonlySet<string> = new Set<string>(PERMISSION_ATOMS);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** `Array.isArray` narrows `unknown` to `any[]`; this narrows it to `unknown[]`. */
const isArray = (v: unknown): v is unknown[] => Array.isArray(v);

const isStringArray = (v: unknown): v is string[] =>
  isArray(v) && v.every((x) => typeof x === 'string');

function toAtomSet(v: unknown): AtomSet | null {
  if (!isStringArray(v)) return null;
  return new Set(v.filter((a): a is PermissionAtom => KNOWN_ATOMS.has(a)));
}

function toAtomEntries(v: unknown): Map<string, AtomSet> | null {
  if (!isArray(v)) return null;
  const out = new Map<string, AtomSet>();
  for (const pair of v) {
    if (!isArray(pair) || pair.length !== 2) return null;
    const [k, atoms] = pair;
    const set = toAtomSet(atoms);
    if (typeof k !== 'string' || !set) return null;
    out.set(k, set);
  }
  return out;
}

const atomEntries = (m: ReadonlyMap<string, AtomSet>): [string, string[]][] =>
  [...m].map(([k, v]) => [k, [...v]]);

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export function serializeMap(map: ProjectPermissionMap): string {
  return JSON.stringify({
    projectId: map.projectId,
    subjectKey: map.subjectKey,
    orgRole: map.orgRole,
    projectAtoms: [...map.projectAtoms],
    areaAtoms: atomEntries(map.areaAtoms),
    entityOverrides: atomEntries(map.entityOverrides),
    restrictedFieldMode: map.restrictedFieldMode,
    validUntil: map.validUntil,
  });
}

export function parseMap(raw: string): ProjectPermissionMap | null {
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) return null;

  const projectId = parsed.projectId;
  const subject = parsed.subjectKey;
  const orgRole = parsed.orgRole;
  const mode = parsed.restrictedFieldMode;
  const validUntil = parsed.validUntil;

  if (typeof projectId !== 'string' || typeof subject !== 'string') return null;
  if (typeof validUntil !== 'number' || !Number.isFinite(validUntil)) return null;
  if (orgRole !== null && !(typeof orgRole === 'string' && isOrgRole(orgRole))) return null;
  if (typeof mode !== 'string' || !isRestrictedFieldMode(mode)) return null;

  const projectAtoms = toAtomSet(parsed.projectAtoms);
  const areaAtoms = toAtomEntries(parsed.areaAtoms);
  const entityOverrides = toAtomEntries(parsed.entityOverrides);
  if (!projectAtoms || !areaAtoms || !entityOverrides) return null;

  return {
    projectId,
    subjectKey: subject,
    orgRole,
    projectAtoms,
    areaAtoms,
    entityOverrides,
    restrictedFieldMode: mode,
    validUntil,
  };
}

function isOrgRole(v: string): v is OrgRole {
  return (ORG_ROLES as readonly string[]).includes(v);
}

function isRestrictedFieldMode(v: string): v is RestrictedFieldMode {
  return (RESTRICTED_FIELD_MODES as readonly string[]).includes(v);
}

export function serializeSkeleton(skel: ProjectSkeleton): string {
  return JSON.stringify({
    generation: skel.generation,
    areaIds: [...skel.areaIds],
    entities: skel.entities.map((e) => [e.id, e.areaId]),
    entitiesWithRestrictedFields: [...skel.entitiesWithRestrictedFields],
  });
}

export function parseSkeleton(raw: string): ProjectSkeleton | null {
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) return null;

  const generation = parsed.generation;
  const areaIds = parsed.areaIds;
  const restricted = parsed.entitiesWithRestrictedFields;
  const rawEntities = parsed.entities;

  if (typeof generation !== 'number') return null;
  if (!isStringArray(areaIds) || !isStringArray(restricted)) return null;
  if (!isArray(rawEntities)) return null;

  const entities: SkeletonEntity[] = [];
  for (const pair of rawEntities) {
    if (!isArray(pair) || pair.length !== 2) return null;
    const [id, areaId] = pair;
    if (typeof id !== 'string') return null;
    if (areaId !== null && typeof areaId !== 'string') return null;
    entities.push({ id, areaId });
  }

  return buildSkeleton(generation, areaIds, entities, restricted);
}

/** One constructor, so `entityById` can never disagree with `entities`. */
export function buildSkeleton(
  generation: number,
  areaIds: readonly string[],
  entities: readonly SkeletonEntity[],
  entitiesWithRestrictedFields: readonly string[],
): ProjectSkeleton {
  return {
    generation,
    areaIds,
    entities,
    entityById: new Map(entities.map((e) => [e.id, e])),
    entitiesWithRestrictedFields: new Set(entitiesWithRestrictedFields),
  };
}
