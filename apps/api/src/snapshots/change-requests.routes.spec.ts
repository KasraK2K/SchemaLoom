import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATED_META,
  PERM_META,
  assertRouteTable,
  isShareLinkRoute,
  markerKeysOn,
  type SweptRoute,
} from '../access';
import { ChangeRequestsController } from './change-requests.controller';

function sweep(): SweptRoute[] {
  const prototype = ChangeRequestsController.prototype as unknown as Record<string, unknown>;
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
      source: `ChangeRequestsController.${name}`,
    });
  }
  return routes;
}

describe('ChangeRequestsController route markers', () => {
  const routes = sweep();
  const table = Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r.markers]));

  it('serves exactly the change-request routes', () => {
    expect(Object.keys(table).sort()).toEqual([
      'DELETE /api/change-requests/:id',
      'GET /api/change-requests/:id',
      'GET /api/change-requests/:id/migration',
      'GET /api/projects/:projectId/change-requests',
      'POST /api/change-requests/:id/close',
      'POST /api/change-requests/:id/merge',
      'POST /api/change-requests/:id/reopen',
      'POST /api/change-requests/:id/reviews',
      'POST /api/change-requests/:id/update-from-main',
      'POST /api/projects/:projectId/change-requests',
    ]);
  });

  it('passes the boot sweep with one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
  });

  it('gates proposing on comment:create and the id-addressed routes on identity', () => {
    const proto = ChangeRequestsController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(PERM_META, proto.create ?? {}) as unknown).toEqual({
      atom: 'comment:create',
      wheres: [{ project: 'projectId' }],
    });
    expect(table['GET /api/change-requests/:id']).toEqual([AUTHENTICATED_META]);
    expect(table['DELETE /api/change-requests/:id']).toEqual([AUTHENTICATED_META]);
  });

  it('exposes nothing to a share-link subject (R21)', () => {
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
