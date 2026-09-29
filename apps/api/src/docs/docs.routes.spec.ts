import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_ACCESS_META,
  assertRouteTable,
  isShareLinkRoute,
  markerKeysOn,
  type SweptRoute,
} from '../access';
import { DocsController } from './docs.controller';

function sweep(): SweptRoute[] {
  const prototype = DocsController.prototype as unknown as Record<string, unknown>;
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
      source: `DocsController.${name}`,
    });
  }
  return routes;
}

describe('DocsController route markers', () => {
  const routes = sweep();
  const table = Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r.markers]));

  it('serves exactly the Phase 5 §1 routes', () => {
    expect(Object.keys(table).sort()).toEqual([
      'GET /api/projects/:projectId/docs',
      'GET /api/projects/:projectId/docs/:targetType/:targetId',
      'PUT /api/projects/:projectId/docs/:targetType/:targetId',
    ]);
  });

  it('passes the boot sweep with one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
  });

  it('gates every route on project access', () => {
    for (const route of routes) expect(route.markers, route.source).toEqual([PROJECT_ACCESS_META]);
  });

  it('exposes only the docs-mode list to a share-link subject (R21)', () => {
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path)).map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /api/projects/:projectId/docs',
    ]);
  });
});
