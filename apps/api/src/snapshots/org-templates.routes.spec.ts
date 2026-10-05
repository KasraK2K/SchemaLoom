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
import { OrgTemplatesController } from './org-templates.controller';

function sweep(): SweptRoute[] {
  const prototype = OrgTemplatesController.prototype as unknown as Record<string, unknown>;
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
      source: `OrgTemplatesController.${name}`,
    });
  }
  return routes;
}

describe('OrgTemplatesController route markers (roadmap 12c)', () => {
  const routes = sweep();
  const table = Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r.markers]));

  it('serves exactly the org-template routes', () => {
    expect(Object.keys(table).sort()).toEqual([
      'DELETE /api/organizations/:orgSlug/templates/:id',
      'GET /api/organizations/:orgSlug/templates',
      'PATCH /api/organizations/:orgSlug/templates/:id',
      'POST /api/projects/:projectId/save-as-template',
    ]);
  });

  it('passes the boot sweep with one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
  });

  it('gates saving on sharing:manage and the org routes on identity', () => {
    const proto = OrgTemplatesController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(PERM_META, proto.save ?? {}) as unknown).toEqual({
      atom: 'sharing:manage',
      wheres: [{ project: 'projectId' }],
    });
    for (const route of [
      'GET /api/organizations/:orgSlug/templates',
      'PATCH /api/organizations/:orgSlug/templates/:id',
      'DELETE /api/organizations/:orgSlug/templates/:id',
    ]) {
      expect(table[route]).toEqual([AUTHENTICATED_META]);
    }
  });

  it('exposes nothing to a share-link subject (R21)', () => {
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
