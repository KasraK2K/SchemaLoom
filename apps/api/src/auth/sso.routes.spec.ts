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
import { SsoController } from './sso.controller';
import { IS_PUBLIC_KEY } from './public.decorator';

/** Doc 01 §4.1 — the boot sweep's assertion, against the real decorator metadata. */
function sweep(): SweptRoute[] {
  const prototype: object = SsoController.prototype;
  const controllerPath = String(Reflect.getMetadata(PATH_METADATA, SsoController) ?? '');
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
        (key) => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, SsoController),
      ),
      source: `SsoController.${name}`,
    });
  }
  return routes;
}

/** Roadmap 14: the sign-in round trip is public; managing connections needs a session. */
const PUBLIC_ROUTES = [
  'GET /api/auth/sso/:id/saml/metadata',
  'GET /api/auth/sso/:id/start',
  'GET /api/auth/sso/oidc/callback',
  'POST /api/auth/sso/discover',
  'POST /api/auth/sso/saml/acs',
];

const AUTHENTICATED_ROUTES = [
  'DELETE /api/organizations/:orgSlug/sso-connections/:id',
  'DELETE /api/organizations/:orgSlug/sso-connections/:id/group-mappings/:mappingId',
  'DELETE /api/organizations/:orgSlug/sso-connections/:id/scim-token',
  'GET /api/organizations/:orgSlug/sso-connections',
  'PATCH /api/organizations/:orgSlug/sso-connections/:id',
  'POST /api/organizations/:orgSlug/sso-connections',
  'POST /api/organizations/:orgSlug/sso-connections/:id/group-mappings',
  'POST /api/organizations/:orgSlug/sso-connections/:id/scim-token',
];

const key = (r: SweptRoute): string => `${r.method} ${r.path}`;

describe('SsoController route markers', () => {
  const routes = sweep();

  it('registers exactly the SSO routes', () => {
    expect(routes.map(key).sort()).toEqual([...PUBLIC_ROUTES, ...AUTHENTICATED_ROUTES].sort());
  });

  it('passes the boot sweep: exactly one marker each, public only before a session', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
    for (const route of routes)
      expect(route.markers).toEqual([
        PUBLIC_ROUTES.includes(key(route)) ? IS_PUBLIC_KEY : AUTHENTICATED_META,
      ]);
  });

  it('exposes no route to a share-link subject (R21)', () => {
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
