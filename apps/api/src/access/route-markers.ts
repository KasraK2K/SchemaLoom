import { BadRequestException, SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { OrgRole, PermissionAtom } from '@schemaloom/contracts';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import type { ResourceRef } from './types';

/**
 * Doc 05 §10.1-§10.2 and doc 01 §4.1 — the route markers. **There is no implicit default
 * for an undecorated route**: every route under `/api/**` carries exactly one of these,
 * `RouteSweep` refuses to start the process otherwise, and `PermissionGuard` denies a
 * route that somehow reaches it unmarked.
 *
 * Punch-list ∆7: the signature is `(atom, locator)`, never `(resourceType, idParam, atom)`.
 * The locator is what makes `@RequirePermissionAll` expressible at all — one atom over a
 * *list* of resources — and it is the only form that can name a link's two endpoints
 * (`{ entity: 'body.from.entityId' }`, `{ entity: 'body.to.entityId' }`, R19).
 *
 * These are `SetMetadata` only, deliberately **without** `UseGuards(PermissionGuard)`:
 * the guard is the second global `APP_GUARD` (doc 01 §4.1), so adding it per route would
 * run it twice.
 */

export const PERM_META = 'schemaloom:permission';
export const PROJECT_ACCESS_META = 'schemaloom:projectAccess';
export const ORG_ROLE_META = 'schemaloom:orgRole';
export const AUTHENTICATED_META = 'schemaloom:authenticated';

/**
 * The string names a route param by default; prefix `body.` or `query.` to look
 * elsewhere. The whole dotted path is walked (see `readLocatorId`).
 */
export type ResourceLocator = { project: string } | { area: string } | { entity: string };

export interface PermissionRequirement {
  readonly atom: PermissionAtom;
  readonly wheres: readonly ResourceLocator[];
}

export interface OrgRoleRequirement {
  readonly param: string;
  readonly roles: readonly OrgRole[];
}

/** §10.1 — one atom at one resource. */
export const RequirePermission = (
  atom: PermissionAtom,
  where: ResourceLocator,
): CustomDecorator =>
  SetMetadata(PERM_META, { atom, wheres: [where] } satisfies PermissionRequirement);

/**
 * §10.1 / R19 — one atom at EVERY listed resource. All-or-nothing: any locator that
 * fails fails the request, which is what makes "a link needs `schema:edit` on both
 * endpoints" a decorator rather than a paragraph in a service.
 */
export const RequirePermissionAll = (
  atom: PermissionAtom,
  wheres: readonly ResourceLocator[],
): CustomDecorator => SetMetadata(PERM_META, { atom, wheres } satisfies PermissionRequirement);

/** §10.2 / §7.9 — `canOpenProject`, not an atom. The response is redacted downstream. */
export const RequireProjectAccess = (param: string): CustomDecorator =>
  SetMetadata(PROJECT_ACCESS_META, param);

/** §10.2 — org-scoped administration; never a project resource. */
export const RequireOrgRole = (param: string, roles: readonly OrgRole[]): CustomDecorator =>
  SetMetadata(ORG_ROLE_META, { param, roles } satisfies OrgRoleRequirement);

/**
 * Doc 01 §4.1 — the marker for a route that names no resource (`GET /auth/me`). It is
 * NOT a default: it says "any established identity may call this", which is a decision,
 * and writing it down is what lets the sweep tell it apart from a forgotten decorator.
 */
export const Authenticated = (): CustomDecorator => SetMetadata(AUTHENTICATED_META, true);

/** Every marker key, in the order a human would check them. `@Public()` is one of them. */
export const ROUTE_MARKER_KEYS = [
  IS_PUBLIC_KEY,
  AUTHENTICATED_META,
  PERM_META,
  PROJECT_ACCESS_META,
  ORG_ROLE_META,
] as const;

export const MARKER_NAMES: Readonly<Record<string, string>> = {
  [IS_PUBLIC_KEY]: '@Public()',
  [AUTHENTICATED_META]: '@Authenticated()',
  [PERM_META]: '@RequirePermission()/@RequirePermissionAll()',
  [PROJECT_ACCESS_META]: '@RequireProjectAccess()',
  [ORG_ROLE_META]: '@RequireOrgRole()',
};

/**
 * Which markers one route carries. `read` is the caller's metadata reader — the guard's
 * is `Reflector.getAllAndOverride([handler, class])`, the sweep's reads the handler then
 * the controller — so there is one definition of "the route's markers" and the boot
 * assertion and the runtime decision cannot drift apart.
 */
export const markerKeysOn = (read: (key: string) => unknown): string[] =>
  ROUTE_MARKER_KEYS.filter((key) => read(key) !== undefined);

/**
 * §10.1 — extraction walks the **whole** dotted path. An earlier draft used
 * `spec.split('.', 2)`, which silently truncates anything deeper than one segment, so
 * `body.from.entityId` — the natural locator for doc 04's link shape — resolved to
 * `req.body.from` and threw `missing_resource_id`.
 */
export function readLocatorId(req: Request, spec: string): string {
  const path = spec.includes('.') ? spec.split('.') : ['params', spec];
  let cursor: unknown = req;
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null) {
      cursor = undefined;
      break;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new BadRequestException({ code: 'missing_resource_id', locator: spec });
  }
  return cursor;
}

export function extract(req: Request, where: ResourceLocator): ResourceRef {
  const entry = Object.entries(where)[0];
  if (!entry) throw new BadRequestException({ code: 'missing_resource_id', locator: '' });
  const [type, spec] = entry;
  if (type !== 'project' && type !== 'area' && type !== 'entity') {
    throw new BadRequestException({ code: 'missing_resource_id', locator: type });
  }
  return { type, id: readLocatorId(req, spec) };
}
