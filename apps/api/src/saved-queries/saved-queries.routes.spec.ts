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
import { SavedQueriesController } from './saved-queries.controller';

function sweep(): SweptRoute[] {
  const prototype = SavedQueriesController.prototype as unknown as Record<string, unknown>;
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
      source: `SavedQueriesController.${name}`,
    });
  }
  return routes;
}

describe('SavedQueriesController route markers', () => {
  const routes = sweep();
  const table = Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r.markers]));

  it('serves exactly the six library routes', () => {
    expect(Object.keys(table).sort()).toEqual([
      'DELETE /api/saved-queries/:id',
      'GET /api/projects/:projectId/saved-queries',
      'GET /api/saved-queries/:id',
      'PATCH /api/saved-queries/:id',
      'POST /api/projects/:projectId/queries/validate',
      'POST /api/projects/:projectId/saved-queries',
    ]);
  });

  it('passes the boot sweep with one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
  });

  it('gates project-scoped routes on project access and id-addressed ones on identity', () => {
    for (const route of routes) {
      const expected = route.path.startsWith('/api/projects/')
        ? PROJECT_ACCESS_META
        : AUTHENTICATED_META;
      expect(route.markers, route.source).toEqual([expected]);
    }
  });

  it('exposes nothing to a share-link subject (R21)', () => {
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
