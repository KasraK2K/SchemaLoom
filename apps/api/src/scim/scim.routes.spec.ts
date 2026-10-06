import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import {
  SCIM_TOKEN_META,
  assertRouteTable,
  isShareLinkRoute,
  markerKeysOn,
  type SweptRoute,
} from '../access';
import { isApiTokenRoute } from '../access/api-token-allowlist';
import { ScimController } from './scim.controller';

/** Roadmap 14b §1.2 — the boot sweep's assertion, against the real decorator metadata. */
function sweep(): SweptRoute[] {
  const prototype: object = ScimController.prototype;
  const controllerPath = String(Reflect.getMetadata(PATH_METADATA, ScimController) ?? '');
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
        (key) => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, ScimController),
      ),
      source: `ScimController.${name}`,
    });
  }
  return routes;
}

const SCIM_ROUTES = [
  'GET /api/scim/v2/ServiceProviderConfig',
  'GET /api/scim/v2/ResourceTypes',
  'GET /api/scim/v2/Schemas',
  'GET /api/scim/v2/Users',
  'POST /api/scim/v2/Users',
  'GET /api/scim/v2/Users/:id',
  'PUT /api/scim/v2/Users/:id',
  'PATCH /api/scim/v2/Users/:id',
  'DELETE /api/scim/v2/Users/:id',
  'GET /api/scim/v2/Groups',
  'POST /api/scim/v2/Groups',
  'GET /api/scim/v2/Groups/:id',
  'PUT /api/scim/v2/Groups/:id',
  'PATCH /api/scim/v2/Groups/:id',
  'DELETE /api/scim/v2/Groups/:id',
];

const key = (r: SweptRoute): string => `${r.method} ${r.path}`;

describe('ScimController route markers', () => {
  const routes = sweep();

  it('registers exactly the SCIM routes', () => {
    expect(routes.map(key).sort()).toEqual([...SCIM_ROUTES].sort());
  });

  it('passes the boot sweep: every route is @RequireScimToken() and nothing else', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
    for (const route of routes) expect(route.markers).toEqual([SCIM_TOKEN_META]);
  });

  it('is reachable by neither a share link (R21) nor an API token', () => {
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
    expect(routes.filter((r) => isApiTokenRoute(r.method, r.path))).toEqual([]);
  });
});
