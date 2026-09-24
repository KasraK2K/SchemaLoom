import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { AtomSet, PermissionAtom } from '@schemaloom/contracts';
import { atomsAt } from './resolve';
import type { ProjectPermissionMap, ProjectSkeleton, ResourceRef } from './types';

/**
 * Doc 05 §4.2 (R4 / R4a) and §10.4 — the three assertions, as pure functions over an
 * already-resolved map. They do no I/O, so a bulk write costs N set lookups, never N
 * resolves.
 */

/**
 * §10.4 — bulk check, ALL-OR-NOTHING. If any ref is denied the whole request fails, so
 * there is no partial-success oracle.
 *
 * Invisibility is checked across EVERY ref before permission is checked on any of them:
 * `403` on a resource the subject cannot see would confirm it exists. An id absent from
 * the skeleton resolves to the empty set and lands in the same branch — one rule covers
 * "not yours" and "not there", which is the whole point of §10.3 step 8.
 */
export function assertAll(
  map: ProjectPermissionMap,
  skel: ProjectSkeleton,
  refs: readonly ResourceRef[],
  atom: PermissionAtom,
): void {
  for (const ref of refs) {
    if (!atomsAt(map, skel, ref).has('schema:view')) {
      throw new NotFoundException({ code: 'not_found', resourceType: ref.type, id: ref.id });
    }
  }
  const denied = refs.filter((ref) => !atomsAt(map, skel, ref).has(atom));
  if (denied.length > 0) {
    throw new ForbiddenException({
      code: 'forbidden',
      atom,
      refs: denied.map((r) => ({ type: r.type, id: r.id })),
    });
  }
}

/**
 * R4 — grant attenuation. A principal may create or update a grant on `ref` only if the
 * proposed materialised set is a subset of the grantor's own effective atoms **at `ref`
 * exactly**, and the grantor holds `sharing:manage` at `ref` or an ancestor (R5, already
 * folded into the map by step 4b of §7.5).
 *
 * Measuring at `ref` exactly is what makes E12(b) a 403: a manager who narrowed HERSELF
 * on one entity is a viewer there, so she cannot widen that grant in place. The escape
 * hatch is delete-then-regrant (R4a), and the error body names it.
 */
export function assertMayGrant(
  map: ProjectPermissionMap,
  skel: ProjectSkeleton,
  ref: ResourceRef,
  proposed: AtomSet,
): void {
  const mine = atomsAt(map, skel, ref);
  if (!mine.has('sharing:manage')) {
    throw new ForbiddenException({ code: 'sharing_not_permitted' });
  }
  const escalation = [...proposed].filter((a) => !mine.has(a));
  if (escalation.length > 0) {
    throw new ForbiddenException({
      code: 'escalation',
      atoms: escalation,
      remedy: 'delete_narrowing_grant',
    });
  }
}

/**
 * R4a — deleting a grant is subject to R5 only, never to R4. Deletion removes access; it
 * cannot escalate anyone, and it is the documented way out of a self-narrowing grant.
 */
export function assertMayDeleteGrant(
  map: ProjectPermissionMap,
  skel: ProjectSkeleton,
  ref: ResourceRef,
): void {
  if (!atomsAt(map, skel, ref).has('sharing:manage')) {
    throw new ForbiddenException({ code: 'sharing_not_permitted' });
  }
}
