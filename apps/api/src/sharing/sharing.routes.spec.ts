import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATED_META,
  PROJECT_ACCESS_META,
  assertRouteTable,
  isShareLinkRoute,
  markerKeysOn,
  type SweptRoute,
} from '../access';
import { SharingController } from './sharing.controller';

function sweep(): SweptRoute[] {
  const prototype = SharingController.prototype as unknown as Record<string, unknown>;
  const routes: SweptRoute[] = [];
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const handler = prototype[name];
    if (name === 'constructor' || typeof handler !== 'function') continue;
    const verb: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
    if (typeof verb !== 'number') continue;
    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    routes.push({
      method: RequestMethod[verb] ?? 'UNKNOWN',
      path: `/api/${typeof path === 'string' ? path : ''}`.replace(/\/+/g, '/'),
      markers: markerKeysOn((key) => Reflect.getMetadata(key, handler)),
      source: `SharingController.${name}`,
    });
  }
  return routes;
}

describe('SharingController route markers', () => {
  const routes = sweep();
  const table = Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r.markers]));

  it('serves exactly the twelve routes apps/web/src/features/sharing calls', () => {
    expect(Object.keys(table).sort()).toEqual([
      'DELETE /api/grants/:grantId',
      'DELETE /api/share-links/:linkId',
      'GET /api/projects/:projectId/access',
      'GET /api/projects/:projectId/access-requests',
      'GET /api/projects/:projectId/access/candidates',
      'GET /api/projects/:projectId/share-links',
      'PATCH /api/grants/:grantId',
      'POST /api/access-requests',
      'POST /api/access-requests/:requestId/approve',
      'POST /api/access-requests/:requestId/deny',
      'POST /api/projects/:projectId/grants',
      'POST /api/projects/:projectId/share-links',
    ]);
  });

  it('passes the boot sweep with one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
  });

  it('gates project-scoped routes on project access and id-addressed ones on identity', () => {
    for (const route of routes) {
      const expected = route.path.startsWith('/api/projects/') ? PROJECT_ACCESS_META : AUTHENTICATED_META;
      expect(route.markers, route.source).toEqual([expected]);
    }
  });

  it('exposes nothing to a share-link subject (R21)', () => {
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
