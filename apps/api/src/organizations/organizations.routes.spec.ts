import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATED_META,
  assertRouteTable,
  isShareLinkRoute,
  markerKeysOn,
  type SweptRoute,
} from '../access';
import { OrganizationsController } from './organizations.controller';

/**
 * Doc 01 §4.1 — the boot sweep aborts the process for an unmarked or doubly-marked route
 * under `/api/**`. Same assertion, against the real decorator metadata.
 */
function sweep(): SweptRoute[] {
  const prototype: object = OrganizationsController.prototype;
  const controllerPath = String(Reflect.getMetadata(PATH_METADATA, OrganizationsController) ?? '');
  const routes: SweptRoute[] = [];

  for (const name of Object.getOwnPropertyNames(prototype)) {
    if (name === 'constructor') continue;
    const handler = (prototype as Record<string, unknown>)[name];
    if (typeof handler !== 'function') continue;
    const verb: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
    if (typeof verb !== 'number') continue;

    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    routes.push({
      method: RequestMethod[verb] ?? 'UNKNOWN',
      path: `/api/${controllerPath}/${typeof path === 'string' ? path : ''}`
        .replace(/\/+/g, '/')
        .replace(/(?!^)\/$/, ''),
      markers: markerKeysOn(
        (key) =>
          Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, OrganizationsController),
      ),
      source: `OrganizationsController.${name}`,
    });
  }
  return routes;
}

describe('OrganizationsController route markers', () => {
  const routes = sweep();

  it('registers the org list, org creation, and the per-org project, workspace and role routes', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'DELETE /api/organizations/:orgSlug/groups/:groupId',
      'DELETE /api/organizations/:orgSlug/groups/:groupId/members/:userId',
      'DELETE /api/organizations/:orgSlug/members/:userId',
      'DELETE /api/organizations/:orgSlug/roles/:roleId',
      'GET /api/organizations',
      'GET /api/organizations/:orgSlug/groups',
      'GET /api/organizations/:orgSlug/members',
      'GET /api/organizations/:orgSlug/projects',
      'GET /api/organizations/:orgSlug/roles',
      'GET /api/organizations/:orgSlug/workspaces',
      'PATCH /api/organizations/:orgSlug/groups/:groupId',
      'PATCH /api/organizations/:orgSlug/members/:userId',
      'PATCH /api/organizations/:orgSlug/roles/:roleId',
      'POST /api/organizations',
      'POST /api/organizations/:orgSlug/groups',
      'POST /api/organizations/:orgSlug/groups/:groupId/members',
      'POST /api/organizations/:orgSlug/roles',
      'POST /api/organizations/:orgSlug/workspaces',
    ]);
  });

  it('passes the boot sweep: exactly one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
    for (const route of routes) expect(route.markers).toHaveLength(1);
  });

  it('marks every route @Authenticated(), never @RequireOrgRole', () => {
    // `@RequireOrgRole` compares `subject.orgId` with its locator and 404s on a mismatch,
    // so it can only admit the session's ACTIVE org — which makes it unable to express
    // either route. It would also turn "you belong to no org yet" into a 404 instead of
    // the empty list the create-org prompt is built on.
    for (const route of routes) expect(route.markers).toEqual([AUTHENTICATED_META]);
  });

  it('exposes no route to a share-link subject (R21)', () => {
    // A link subject never reaches the @Authenticated() marker: PermissionGuard 404s any
    // route outside SHARE_LINK_ROUTES for a link session before the marker is read.
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
