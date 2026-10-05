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
import { AiController } from './ai.controller';

function sweep(): SweptRoute[] {
  const prototype = AiController.prototype as unknown as Record<string, unknown>;
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
      source: `AiController.${name}`,
    });
  }
  return routes;
}

describe('AiController route markers', () => {
  const routes = sweep();
  const table = Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r.markers]));

  it('serves exactly the DESIGN §4.2 routes, minus the settings PATCH', () => {
    expect(Object.keys(table).sort()).toEqual([
      'GET /api/ai/threads/:id',
      'GET /api/projects/:projectId/agent/outline',
      'GET /api/projects/:projectId/ai/doc-drafts',
      'GET /api/projects/:projectId/ai/threads',
      'POST /api/ai/doc-drafts/:id/accept',
      'POST /api/ai/doc-drafts/:id/reject',
      'POST /api/ai/threads/:id/messages',
      'POST /api/projects/:projectId/agent/context',
      'POST /api/projects/:projectId/agent/proposals',
      'POST /api/projects/:projectId/ai/doc-drafts',
      'POST /api/projects/:projectId/ai/draft-schema',
      'POST /api/projects/:projectId/ai/threads',
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
