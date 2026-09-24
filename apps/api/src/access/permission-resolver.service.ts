import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AtomSet, OrgRole, PermissionAtom, RestrictedFieldMode } from '@schemaloom/contracts';
import type { Redis } from 'ioredis';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REDIS_CACHE } from '../redis/redis.tokens';
import {
  PERMISSION_MAP_TTL_CAP_SEC,
  PERMISSION_SKELETON_TTL_SEC,
  cappedTtlSec,
  setWithTtl,
} from '../redis/ttl';
import { assertAll, assertMayDeleteGrant, assertMayGrant } from './assertions';
import {
  ALL_ATOMS,
  SHARE_LINK_CEILING,
  intersect,
  materialise,
  unionAll,
  withAtom,
  without,
} from './atoms';
import {
  buildSkeleton,
  orgMemberKey,
  parseMap,
  parseSkeleton,
  permMapKey,
  serializeMap,
  serializeSkeleton,
  skeletonKey,
  type Generations,
} from './cache-keys';
import {
  allAccessMap,
  ancestorChain,
  atomsAt,
  canOpenProject,
  computeProjectMap,
  emptyMap,
  restrictedOkEntityIds,
  visibleEntityIds,
} from './resolve';
import {
  principalKey,
  splitPrincipalKey,
  subjectKey,
  type DroppedGrantReason,
  type LiveGrant,
  type PrincipalKey,
  type PrincipalKind,
  type ProjectPermissionMap,
  type ProjectSkeleton,
  type ResourceRef,
  type Subject,
} from './types';

/**
 * Doc 05 §7 and §9 — the only thing in the codebase that reads `access_grants`.
 * A repository method that does, outside this module, is a review failure.
 *
 * This class is I/O and caching. Every rule lives in `resolve.ts` / `assertions.ts` as a
 * pure function, which is what makes R13-R18 testable as a matrix with no database.
 *
 * **Seams left for later build-order steps, deliberately not built here:**
 * - step 11: `PermissionGuard`, `@RequirePermission`, `@RequireProjectAccess`, the
 *   boot-time route sweep and `SHARE_LINK_ROUTES` (§10.2, R21).
 * - step 12: `VisibilityFilter` — it consumes `skeleton()`, `visibleEntityIds()` and
 *   `restrictedOkEntityIds()`, all exported here already.
 * - the grant write path (§7.14) calls `resolveProjectUncached` inside its advisory lock,
 *   then `invalidate({ project })` after the commit.
 */
@Injectable()
export class PermissionResolver {
  private readonly logger = new Logger(PermissionResolver.name);

  /**
   * §9.5 — per-process in-flight deduplication. The real herd is one request resolving
   * the same key many times, not fifty processes racing a cold key. Keys are namespaced
   * (`perm:` / `skel:` / `orgmem:`), so one map cannot collide across shapes.
   *
   * Skipped: a Redis single-flight lock. Add it when a flame graph shows resolve cost.
   */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS_CACHE) private readonly cache: Redis,
  ) {}

  // =====================================================================================
  // Public surface
  // =====================================================================================

  /** §7.5 — the subject's whole view of one project. Cached (§9). */
  async resolveProject(subject: Subject, projectId: string): Promise<ProjectPermissionMap> {
    const maps = await this.resolveProjects(subject, [projectId]);
    return maps.get(projectId) ?? emptyMap(projectId, subject);
  }

  /**
   * §10.4 — `GET /projects` resolves 3-20 candidate projects at once. The project row and
   * all three generation counters come back for every one of them in a SINGLE round trip;
   * the org-membership lookup is shared through its own cache entry, and each project's
   * map is then a cache hit or one small query.
   *
   * There is no per-entity call anywhere, in either direction: the resolver's unit of work
   * is a PROJECT, and `atomsAt` answers all 300 entity questions from the returned map
   * with no I/O at all. A 300-entity project is one grants query, not 300 resolves.
   */
  async resolveProjects(
    subject: Subject,
    projectIds: readonly string[],
  ): Promise<Map<string, ProjectPermissionMap>> {
    const ids = [...new Set(projectIds)];
    const out = new Map<string, ProjectPermissionMap>();
    if (ids.length === 0) return out;

    const rows = await this.readProjectRows(ids, generationUserId(subject));
    const resolved = await Promise.all(
      [...rows.values()].map(
        async (row) => [row.projectId, await this.cachedMap(subject, row)] as const,
      ),
    );
    for (const [id, map] of resolved) out.set(id, map);
    // Step 0: a project that does not exist, is soft-deleted, or whose org is soft-deleted
    // has no row to key a cache entry by, so `EMPTY_MAP` never enters the cache.
    for (const id of ids) if (!out.has(id)) out.set(id, emptyMap(id, subject));
    return out;
  }

  /**
   * §7.14 — the grant write path re-resolves the grantor INSIDE its advisory lock, so R4
   * is never measured against a stale map. Bypasses Redis on both read and write; the
   * lock, not the cache, is what serialises it.
   */
  async resolveProjectUncached(
    subject: Subject,
    projectId: string,
  ): Promise<ProjectPermissionMap> {
    const rows = await this.readProjectRows([projectId], generationUserId(subject));
    const row = rows.get(projectId);
    if (!row) return emptyMap(projectId, subject);
    return this.compute(subject, row, { useCache: false });
  }

  /** §7.5 — subject-independent, cached for 600 s, shared across every user of a project. */
  async skeleton(projectId: string): Promise<ProjectSkeleton> {
    const rows = await this.readProjectRows([projectId], null);
    const row = rows.get(projectId);
    return this.skeletonAt(projectId, row?.pg ?? 0);
  }

  /** §7.5. Effective atoms at one resource. Pure; no I/O. */
  atomsAt(map: ProjectPermissionMap, skel: ProjectSkeleton, ref: ResourceRef): AtomSet {
    return atomsAt(map, skel, ref);
  }

  /** §10.4. Bulk check, all-or-nothing. Throws 403, or 404 if any ref is invisible. */
  assertAll(
    map: ProjectPermissionMap,
    skel: ProjectSkeleton,
    refs: readonly ResourceRef[],
    atom: PermissionAtom,
  ): void {
    assertAll(map, skel, refs, atom);
  }

  /** R4 — attenuation, measured at the resource exactly. */
  assertMayGrant(
    map: ProjectPermissionMap,
    skel: ProjectSkeleton,
    ref: ResourceRef,
    proposed: AtomSet,
  ): void {
    assertMayGrant(map, skel, ref, proposed);
  }

  /** R4a — deletion is subject to R5 only, never to R4. */
  assertMayDeleteGrant(map: ProjectPermissionMap, skel: ProjectSkeleton, ref: ResourceRef): void {
    assertMayDeleteGrant(map, skel, ref);
  }

  /** §7.9 — derived from the map alone; no skeleton, so the projects list stays cheap. */
  canOpenProject(map: ProjectPermissionMap): boolean {
    return canOpenProject(map);
  }

  /**
   * §10.2 — the only question `@RequireOrgRole` asks. One indexed lookup on
   * `(organizationId, userId)`.
   *
   * Deliberately NOT cached: `orgMemberKey` is keyed by a project's generation triple,
   * and an org-administration route has no project to key by. Inventing a second cache
   * shape for one `findUnique` would be a second invalidation path to get wrong.
   */
  async orgRole(orgId: string, userId: string): Promise<OrgRole | null> {
    const member = await this.prisma.orgMember.findUnique({
      where: { organizationId_userId: { organizationId: orgId, userId } },
      select: { role: true },
    });
    return member?.role ?? null;
  }

  /** §8.3 — what `VisibilityFilter` (step 12) needs from a resolved map. */
  visibleEntityIds(map: ProjectPermissionMap, skel: ProjectSkeleton): Set<string> {
    return visibleEntityIds(map, skel);
  }

  /** §7.10 — per entity, never a boolean: `field:viewRestricted` can be area-scoped. */
  restrictedOkEntityIds(map: ProjectPermissionMap, skel: ProjectSkeleton): Set<string> {
    return restrictedOkEntityIds(map, skel);
  }

  /**
   * R23, §7.7 — the inverse resolver: who can do what at ONE resource, already
   * ceiling-adjusted. A handful of indexed queries independent of the number of entities,
   * not one `resolveProject` per principal (which would cost 40+ full resolves per
   * `dryRun` keystroke on a project with 40 grants).
   *
   * Keyed by `PrincipalKey` with groups already expanded to their member users, because
   * every consumer — the "Who has access" dialog, the defeated-grant warning,
   * access-request routing — lists people.
   */
  async resolveResource(projectId: string, ref: ResourceRef): Promise<Map<PrincipalKey, AtomSet>> {
    const out = new Map<PrincipalKey, AtomSet>();
    const rows = await this.readProjectRows([projectId], null);
    const row = rows.get(projectId);
    if (!row) return out;

    const skel = await this.skeletonAt(projectId, row.pg);
    if (ref.type === 'entity' && !skel.entityById.has(ref.id)) return out;
    if (ref.type === 'area' && !skel.areaIds.includes(ref.id)) return out;
    if (ref.type === 'project' && ref.id !== projectId) return out;

    const chain = ancestorChain(projectId, ref, skel);
    const grants = await this.grantsOnChain(projectId, chain);

    // R15 evaluated for everyone at once: for each principal the most specific chain level
    // carrying a grant decides, entirely. R5's downward union then adds `sharing:manage`
    // held at any BROADER level of the same chain — step 4b of §7.5, same rule, so P13
    // (this agrees with `atomsAt(resolveProject(...))`) holds.
    const byPrincipal = new Map<PrincipalKey, AtomSet>();
    for (const p of new Set(grants.map((g) => g.principalKey))) {
      const mine = grants.filter((g) => g.principalKey === p);
      const levelOf = (g: LiveGrant): number =>
        chain.findIndex((c) => c.type === g.resourceType && c.id === g.resourceId);
      const deciding = Math.min(...mine.map(levelOf).filter((i) => i >= 0));
      if (!Number.isFinite(deciding)) continue;
      let atoms = unionAll(mine.filter((g) => levelOf(g) === deciding).map((g) => materialise(g)));
      if (mine.some((g) => levelOf(g) > deciding && materialise(g).has('sharing:manage'))) {
        atoms = withAtom(atoms, 'sharing:manage');
      }
      byPrincipal.set(p, atoms);
    }

    await this.expandPrincipals(row.organizationId, byPrincipal, out);
    return out;
  }

  /**
   * §9.3 — post-commit cache eviction.
   *
   * Correctness does NOT depend on this: the three generation counters are part of every
   * key and are read from Postgres on every resolve, so the moment the bumping transaction
   * commits, the old entries are unreachable (§9.4 — "there is no window"). What this buys
   * is memory, on an instance running `--maxmemory-policy noeviction`.
   *
   * ponytail: a bounded best-effort SCAN. Permission maps for OTHER projects in a bumped
   * org are left to their <=300 s TTL rather than scanned for — they are already
   * unreachable. Upgrade path if Redis memory ever shows up: a per-org key tag.
   */
  async invalidate(scope: { project?: string; org?: string; user?: string }): Promise<void> {
    this.inFlight.clear();
    const patterns: string[] = [];
    if (scope.project !== undefined) {
      patterns.push(`perm:3:${scope.project}:*`, `skel:3:${scope.project}:*`);
    }
    if (scope.org !== undefined) patterns.push(`orgmem:3:${scope.org}:*`);
    if (scope.user !== undefined) patterns.push(`orgmem:3:*:${scope.user}:*`);
    for (const pattern of patterns) await this.scanDelete(pattern);
  }

  // =====================================================================================
  // Resolution
  // =====================================================================================

  private cachedMap(subject: Subject, row: ProjectRow): Promise<ProjectPermissionMap> {
    const key = permMapKey(row.projectId, subjectKey(subject), row);
    return this.single(key, async () => {
      const hit = await this.readMap(key);
      if (hit) return hit;
      return this.compute(subject, row, { useCache: true, key });
    });
  }

  private async compute(
    subject: Subject,
    row: ProjectRow,
    opts: { useCache: boolean; key?: string },
  ): Promise<ProjectPermissionMap> {
    const nowMs = Date.now();
    const now = new Date(nowMs);

    // ---- step 1: the skeleton, BEFORE any short-circuit -------------------------------
    // ALL_ACCESS_MAP needs its area ids. Resolving it after the org-role branch was a real
    // bug: org owners got an empty visible set and VisibilityFilter redacted the whole
    // schema away from them.
    const skel = await this.skeletonAt(row.projectId, row.pg, opts.useCache);

    let orgRole: OrgRole | null = null;
    let principals: PrincipalKey[];
    let linkExpiresAt: Date | null = null;

    if (subject.kind === 'user') {
      // ---- step 2: org role short-circuit (R13) ---------------------------------------
      const member = await this.orgMembership(subject.userId, row, opts.useCache);
      if (!member) return emptyMap(row.projectId, subject); // R12.2
      orgRole = member.role;
      if (orgRole === 'owner' || orgRole === 'admin') {
        // Grants are not read AT ALL — the short-circuit is inescapable by construction,
        // not by a later subtraction someone could forget. A narrowing grant on an admin
        // is inert (E8).
        const map = allAccessMap(
          row.projectId,
          skel,
          subject,
          orgRole,
          row.restrictedFieldMode,
          nowMs,
        );
        await this.maybeWriteMap(opts, map, nowMs);
        return map;
      }
      principals = [
        principalKey('user', subject.userId),
        ...member.groupIds.map((g) => principalKey('group', g)),
      ];
    } else {
      // §7.12 step 4 — a share-link session can never address a second project.
      if (subject.projectId !== row.projectId) return emptyMap(row.projectId, subject);
      const link = await this.prisma.shareLink.findFirst({
        where: {
          id: subject.shareLinkId,
          projectId: row.projectId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { expiresAt: true },
      });
      if (!link) return emptyMap(row.projectId, subject); // R12.2
      linkExpiresAt = link.expiresAt;
      principals = [principalKey('share_link', subject.shareLinkId)];
    }

    // ---- step 3: one data read ---------------------------------------------------------
    const grants = await this.liveGrants(row.projectId, principals, now, linkExpiresAt);

    const map = computeProjectMap({
      projectId: row.projectId,
      subject,
      orgRole,
      principals,
      grants,
      skeleton: skel,
      restrictedFieldMode: row.restrictedFieldMode,
      nowMs,
      onDroppedGrant: (reason, grant) => {
        this.warnDroppedGrant(reason, grant, row.projectId);
      },
    });
    await this.maybeWriteMap(opts, map, nowMs);
    return map;
  }

  // =====================================================================================
  // Postgres
  // =====================================================================================

  /**
   * §9.1/§9.2 — the project row AND all three generation counters in ONE round trip.
   *
   * **There is deliberately no Redis mirror of the counters.** A mirror with a write-back
   * on miss races the revoke `DEL` on every revoke under load: request A reads generation
   * 42 from Postgres, the revoke commits 43 and `DEL`s a key that is not there yet, A then
   * writes 42 back with a 10 s TTL, and for ten seconds every process builds the
   * PRE-revoke cache key and hits the pre-revoke map. The revoked grant keeps working —
   * the exact resurrection the Postgres-resident counter exists to prevent. One indexed
   * three-integer read per resolve is the price of "there is no window".
   *
   * The `WHERE` also carries step 0: a soft-deleted project or org returns no row.
   */
  private async readProjectRows(
    projectIds: readonly string[],
    userId: string | null,
  ): Promise<Map<string, ProjectRow>> {
    const out = new Map<string, ProjectRow>();
    if (projectIds.length === 0) return out;
    const rows = await this.prisma.$queryRaw<RawProjectRow[]>`
      SELECT p.id                          AS "projectId",
             p.organization_id             AS "organizationId",
             p.restricted_field_mode::text AS "restrictedFieldMode",
             p.perm_generation             AS "pg",
             o.perm_generation             AS "og",
             COALESCE(u.perm_generation, 0) AS "sg"
        FROM projects p
        JOIN organizations o ON o.id = p.organization_id AND o.deleted_at IS NULL
        LEFT JOIN users u ON u.id = ${userId}::text
       WHERE p.id IN (${Prisma.join([...projectIds])})
         AND p.deleted_at IS NULL`;
    for (const r of rows) {
      out.set(r.projectId, {
        projectId: r.projectId,
        organizationId: r.organizationId,
        restrictedFieldMode: r.restrictedFieldMode === 'hide' ? 'hide' : 'mask',
        pg: Number(r.pg),
        og: Number(r.og),
        sg: Number(r.sg),
      });
    }
    return out;
  }

  /** §7.5's hot query. One indexed scan per principal, on `(projectId, principal)`. */
  private async liveGrants(
    projectId: string,
    principals: readonly PrincipalKey[],
    now: Date,
    linkExpiresAt: Date | null,
  ): Promise<LiveGrant[]> {
    if (principals.length === 0) return [];
    const rows = await this.prisma.accessGrant.findMany({
      where: {
        projectId,
        OR: principals.map((p) => {
          const { kind, id } = splitPrincipalKey(p);
          return { principalType: kind, principalId: id };
        }),
        // R12.1 — expiry is a SQL predicate at resolve time, never a cron. A cron that
        // runs late means an expired grant still works.
        AND: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      },
      select: GRANT_SELECT,
      // R18 does not depend on this — the set algebra is order-independent — but a stable
      // read order keeps the serialised map byte-identical between resolves.
      orderBy: { id: 'asc' },
    });

    // R12.2 liveness needs no extra join here. A `user` principal is live iff it is an
    // OrgMember of the grant's organizationId, and the only user principal in this query
    // is the subject, whose membership in THIS project's org was checked in step 2 (C6
    // keeps `grant.organizationId` equal to the project's). A `group` principal is live
    // iff the subject is a current member — which is where the group ids came from. A
    // `share_link` principal is the subject, already checked, its expiry passed in.
    return rows.flatMap((r) => toLiveGrant(r, linkExpiresAt));
  }

  /** §7.7 query 1 — every live grant anywhere on one 1-3 element ancestor chain. */
  private async grantsOnChain(
    projectId: string,
    chain: readonly ResourceRef[],
  ): Promise<LiveGrant[]> {
    const now = new Date();
    const rows = await this.prisma.accessGrant.findMany({
      where: {
        projectId,
        OR: chain.map((c) => ({ resourceType: c.type, resourceId: c.id })),
        AND: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      },
      select: GRANT_SELECT,
      orderBy: { id: 'asc' },
    });

    // Here the share links are NOT the subject, so their liveness is a real lookup — one
    // extra query, and only when the chain actually carries link grants.
    const linkIds = rows.filter((r) => r.principalType === 'share_link').map((r) => r.principalId);
    const liveLinks = new Map<string, Date | null>();
    if (linkIds.length > 0) {
      const links = await this.prisma.shareLink.findMany({
        where: {
          id: { in: linkIds },
          projectId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        select: { id: true, expiresAt: true },
      });
      for (const l of links) liveLinks.set(l.id, l.expiresAt);
    }

    return rows
      .filter((r) => r.principalType !== 'share_link' || liveLinks.has(r.principalId))
      .flatMap((r) => toLiveGrant(r, liveLinks.get(r.principalId) ?? null));
  }

  /**
   * §7.7 query 2 — expand groups to users, fold in the org roles, then apply the ceilings
   * LAST (R17): share links are intersected with `{schema:view}`, guests lose
   * `sharing:manage` (R9), and org owners/admins are overwritten with all nine (R13).
   */
  private async expandPrincipals(
    organizationId: string,
    byPrincipal: ReadonlyMap<PrincipalKey, AtomSet>,
    out: Map<PrincipalKey, AtomSet>,
  ): Promise<void> {
    const groupIds: string[] = [];
    const userIds: string[] = [];
    for (const p of byPrincipal.keys()) {
      const { kind, id } = splitPrincipalKey(p);
      if (kind === 'group') groupIds.push(id);
      if (kind === 'user') userIds.push(id);
    }

    const membersByGroup = new Map<string, string[]>();
    if (groupIds.length > 0) {
      const rows = await this.prisma.groupMember.findMany({
        where: { groupId: { in: groupIds }, group: { organizationId } },
        select: { groupId: true, userId: true },
      });
      for (const r of rows) {
        const list = membersByGroup.get(r.groupId) ?? [];
        list.push(r.userId);
        membersByGroup.set(r.groupId, list);
        userIds.push(r.userId);
      }
    }

    const orgMembers = await this.prisma.orgMember.findMany({
      where: {
        organizationId,
        OR: [{ role: { in: ['owner', 'admin'] } }, { userId: { in: [...new Set(userIds)] } }],
      },
      select: { userId: true, role: true },
    });
    const roleByUser = new Map<string, OrgRole>(orgMembers.map((m) => [m.userId, m.role]));

    const add = (key: PrincipalKey, atoms: AtomSet): void => {
      const existing = out.get(key);
      out.set(key, existing ? unionAll([existing, atoms]) : atoms);
    };

    for (const [p, atoms] of byPrincipal) {
      const { kind, id } = splitPrincipalKey(p);
      if (kind === 'share_link') {
        add(p, intersect(atoms, SHARE_LINK_CEILING)); // R17
        continue;
      }
      // R12.2 — a user principal is live only while an OrgMember of this org.
      for (const u of kind === 'group' ? (membersByGroup.get(id) ?? []) : [id]) {
        if (roleByUser.has(u)) add(principalKey('user', u), atoms);
      }
    }

    for (const [userId, role] of roleByUser) {
      const key = principalKey('user', userId);
      if (role === 'owner' || role === 'admin') {
        out.set(key, ALL_ATOMS); // R13 — inescapable, and it overwrites rather than unions
      } else if (role === 'guest') {
        const atoms = out.get(key);
        if (atoms) out.set(key, without(atoms, 'sharing:manage')); // R9 / R17
      }
    }
  }

  private async orgMembership(
    userId: string,
    row: ProjectRow,
    useCache: boolean,
  ): Promise<OrgMembership | null> {
    const key = orgMemberKey(row.organizationId, userId, row);
    if (useCache) {
      const hit = await this.readOrgMembership(key);
      if (hit) return hit;
    }
    const [member, groups] = await this.prisma.$transaction([
      this.prisma.orgMember.findUnique({
        where: { organizationId_userId: { organizationId: row.organizationId, userId } },
        select: { role: true },
      }),
      this.prisma.groupMember.findMany({
        where: { userId, group: { organizationId: row.organizationId } },
        select: { groupId: true },
        orderBy: { groupId: 'asc' },
      }),
    ]);
    if (!member) return null; // not cached: a non-membership is one indexed lookup
    const value: OrgMembership = { role: member.role, groupIds: groups.map((g) => g.groupId) };
    if (useCache) await this.write(key, JSON.stringify(value), PERMISSION_MAP_TTL_CAP_SEC);
    return value;
  }

  private skeletonAt(projectId: string, pg: number, useCache = true): Promise<ProjectSkeleton> {
    const key = skeletonKey(projectId, pg);
    const load = async (): Promise<ProjectSkeleton> => {
      if (useCache) {
        const raw = await this.read(key);
        const hit = raw === null ? null : parseSkeleton(raw);
        if (hit) return hit;
      }
      const [entities, areas, restricted] = await this.prisma.$transaction([
        this.prisma.entity.findMany({
          where: { projectId },
          select: { id: true, areaId: true },
          orderBy: { id: 'asc' },
        }),
        this.prisma.area.findMany({
          where: { projectId },
          select: { id: true },
          orderBy: { id: 'asc' },
        }),
        // §7.5 — "which entities have a restricted field", never "which field ids". The
        // deleted `fieldsByEntity` was 90 % of the payload for a consumer that does not
        // exist.
        this.prisma.field.findMany({
          where: { projectId, isRestricted: true },
          select: { entityId: true },
          distinct: ['entityId'],
          orderBy: { entityId: 'asc' },
        }),
      ]);
      const skel = buildSkeleton(
        pg,
        areas.map((a) => a.id),
        entities,
        restricted.map((f) => f.entityId),
      );
      if (useCache) await this.write(key, serializeSkeleton(skel), PERMISSION_SKELETON_TTL_SEC);
      return skel;
    };
    return useCache ? this.single(key, load) : load();
  }

  // =====================================================================================
  // Redis. Every failure degrades to a recompute from Postgres; Redis holds only values
  // derived FROM the authoritative generation, so it can never be the reason an answer is
  // wrong — only the reason one is slow.
  // =====================================================================================

  private async readMap(key: string): Promise<ProjectPermissionMap | null> {
    const raw = await this.read(key);
    if (raw === null) return null;
    const map = parseMap(raw);
    if (!map) return null;
    // §9.1 — freshness is re-checked on every read. A link expiring in 30 s must not leave
    // a 300 s map live; the entry's own TTL is only an upper bound.
    if (map.validUntil > Date.now()) return map;
    await this.del(key);
    return null;
  }

  private async readOrgMembership(key: string): Promise<OrgMembership | null> {
    const raw = await this.read(key);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { role, groupIds } = parsed as { role?: unknown; groupIds?: unknown };
    if (typeof role !== 'string' || !isOrgRoleValue(role)) return null;
    if (!Array.isArray(groupIds)) return null;
    const ids: string[] = [];
    for (const g of groupIds as unknown[]) {
      if (typeof g !== 'string') return null;
      ids.push(g);
    }
    return { role, groupIds: ids };
  }

  private async maybeWriteMap(
    opts: { useCache: boolean; key?: string },
    map: ProjectPermissionMap,
    nowMs: number,
  ): Promise<void> {
    const key = opts.key;
    if (!opts.useCache || key === undefined) return;
    if (!Number.isFinite(map.validUntil)) return;
    // §9.1, normative: `min(300 s, validUntil − now)` — REMAINING SECONDS, not a
    // comparison against an absolute timestamp. A literal `min(300, validUntil)` against
    // an epoch millisecond count always picks 300 and silently disables the expiry-derived
    // TTL, leaving a link that expires in 30 s behind a 300 s map.
    const ttl = cappedTtlSec(new Date(map.validUntil), new Date(nowMs));
    if (ttl === null) return; // already expired, or EMPTY_MAP — never cached
    await this.write(key, serializeMap(map), ttl);
  }

  private async read(key: string): Promise<string | null> {
    try {
      return await this.cache.get(key);
    } catch (err) {
      this.logger.warn(`permission cache read failed for ${key}: ${errText(err)}`);
      return null;
    }
  }

  private async write(key: string, value: string, ttlSec: number): Promise<void> {
    try {
      await setWithTtl(this.cache, key, value, ttlSec);
    } catch (err) {
      this.logger.warn(`permission cache write failed for ${key}: ${errText(err)}`);
    }
  }

  private async del(key: string): Promise<void> {
    try {
      await this.cache.del(key);
    } catch (err) {
      this.logger.warn(`permission cache del failed for ${key}: ${errText(err)}`);
    }
  }

  /**
   * ioredis applies `keyPrefix` to keys passed to commands but NOT to a SCAN MATCH
   * pattern, and the keys SCAN returns are fully prefixed. So the pattern is prefixed by
   * hand and the results are un-prefixed before UNLINK, which would otherwise prefix them
   * a second time.
   */
  private async scanDelete(pattern: string): Promise<void> {
    const prefix = this.cache.options.keyPrefix ?? '';
    try {
      let cursor = '0';
      let scanned = 0;
      do {
        const [next, keys] = await this.cache.scan(
          cursor,
          'MATCH',
          `${prefix}${pattern}`,
          'COUNT',
          500,
        );
        cursor = next;
        scanned += keys.length;
        if (keys.length > 0) await this.cache.unlink(...keys.map((k) => k.slice(prefix.length)));
      } while (cursor !== '0' && scanned < SCAN_DELETE_BUDGET);
    } catch (err) {
      this.logger.warn(`permission cache invalidation failed for ${pattern}: ${errText(err)}`);
    }
  }

  private single<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    const p = fn().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  /**
   * §7.15 — a structured warn line per dropped row. A non-zero rate is a bug report: it
   * means a delete path (§7.11's area delete or entity delete) is missing, not routine
   * hygiene. Backed by the weekly sweep, which deletes what this only refuses to resolve.
   */
  private warnDroppedGrant(reason: DroppedGrantReason, grant: LiveGrant, projectId: string): void {
    this.logger.warn(
      `${reason}: grant ${grant.id} points at ${grant.resourceType} ${grant.resourceId} in project ${projectId}`,
    );
  }
}

/** A bounded sweep: invalidation is memory reclamation, never correctness (§9.4). */
const SCAN_DELETE_BUDGET = 10_000;

/** One select, so the two grant queries cannot drift apart. */
const GRANT_SELECT = {
  id: true,
  resourceType: true,
  resourceId: true,
  principalType: true,
  principalId: true,
  canUseAi: true,
  canViewRestricted: true,
  expiresAt: true,
  role: { select: { atoms: true } },
} as const;

interface GrantRow {
  id: string;
  resourceType: 'project' | 'area' | 'entity';
  resourceId: string;
  principalType: 'user' | 'group' | 'email_invite' | 'share_link';
  principalId: string;
  canUseAi: boolean;
  canViewRestricted: boolean;
  expiresAt: Date | null;
  role: { atoms: string[] };
}

/**
 * R11 / §6.4 — an `email_invite` grant is a PENDING grant and grants nothing, because
 * there is no session to attach it to. Dropping it here (rather than filtering in SQL) is
 * what keeps the resolver from ever matching a grant on an unverified email string.
 */
function toLiveGrant(r: GrantRow, linkExpiresAt: Date | null): LiveGrant[] {
  if (r.principalType === 'email_invite') return [];
  const kind: PrincipalKind = r.principalType;
  return [
    {
      id: r.id,
      resourceType: r.resourceType,
      resourceId: r.resourceId,
      principalKey: principalKey(kind, r.principalId),
      atoms: r.role.atoms,
      canUseAi: r.canUseAi,
      canViewRestricted: r.canViewRestricted,
      expiresAt: r.expiresAt,
      linkExpiresAt: kind === 'share_link' ? linkExpiresAt : null,
    },
  ];
}

/** §9.1 — `sg` is 0 for a share-link subject; a link has no user-scoped state. */
const generationUserId = (s: Subject): string | null => (s.kind === 'user' ? s.userId : null);

interface RawProjectRow {
  projectId: string;
  organizationId: string;
  restrictedFieldMode: string;
  pg: number | bigint;
  og: number | bigint;
  sg: number | bigint;
}

export interface ProjectRow extends Generations {
  readonly projectId: string;
  readonly organizationId: string;
  readonly restrictedFieldMode: RestrictedFieldMode;
}

interface OrgMembership {
  readonly role: OrgRole;
  readonly groupIds: readonly string[];
}

const ORG_ROLE_VALUES: ReadonlySet<string> = new Set(['owner', 'admin', 'member', 'guest']);
const isOrgRoleValue = (v: string): v is OrgRole => ORG_ROLE_VALUES.has(v);

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
