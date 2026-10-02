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
import { EnginesController } from './engines.controller';

function sweep(): SweptRoute[] {
  const prototype = EnginesController.prototype as unknown as Record<string, unknown>;
  const base = String(Reflect.getMetadata(PATH_METADATA, EnginesController) ?? '');
  const routes: SweptRoute[] = [];
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const handler = prototype[name];
    if (name === 'constructor' || typeof handler !== 'function') continue;
    const verb: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
    if (typeof verb !== 'number') continue;
    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    routes.push({
      method: RequestMethod[verb] ?? 'UNKNOWN',
      path: `/api/${base}/${typeof path === 'string' ? path : ''}`
        .replace(/\/+/g, '/')
        .replace(/\/$/, ''),
      markers: markerKeysOn((key) => Reflect.getMetadata(key, handler)),
      source: `EnginesController.${name}`,
    });
  }
  return routes;
}

describe('EnginesController route markers', () => {
  const routes = sweep();
  const table = Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r.markers]));

  it('serves the catalog and template sources', () => {
    expect(Object.keys(table).sort()).toEqual([
      'GET /api/engines',
      'GET /api/engines/:engineId/templates/:templateId',
    ]);
  });

  it('passes the boot sweep with one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
  });

  it('engine data needs only a signed-in caller: @Authenticated', () => {
    for (const route of routes) expect(route.markers, route.source).toEqual([AUTHENTICATED_META]);
  });

  it('exposes nothing to a share-link subject (R21)', () => {
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
