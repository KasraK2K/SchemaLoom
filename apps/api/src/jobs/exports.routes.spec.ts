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
import { ExportsController } from './exports.controller';

function sweep(): SweptRoute[] {
  const prototype = ExportsController.prototype as unknown as Record<string, unknown>;
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
      source: `ExportsController.${name}`,
    });
  }
  return routes;
}

describe('ExportsController route markers', () => {
  const routes = sweep();
  const table = Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r.markers]));

  it('serves exactly the three export routes', () => {
    expect(Object.keys(table).sort()).toEqual([
      'GET /api/exports/:id',
      'POST /api/exports/:id/complete',
      'POST /api/projects/:projectId/exports',
    ]);
  });

  it('passes the boot sweep with one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
  });

  it('gates the start on export:run and the id-addressed routes on identity', () => {
    expect(table['POST /api/projects/:projectId/exports']).toEqual([PERM_META]);
    expect(table['GET /api/exports/:id']).toEqual([AUTHENTICATED_META]);
    expect(table['POST /api/exports/:id/complete']).toEqual([AUTHENTICATED_META]);
    const create = (ExportsController.prototype as unknown as Record<string, object>).create;
    expect(Reflect.getMetadata(PERM_META, create ?? {}) as unknown).toMatchObject({
      atom: 'export:run',
    });
  });

  it('exposes nothing to a share-link subject (R21)', () => {
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
