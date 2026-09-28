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
import { AuthController } from './auth.controller';
import { IS_PUBLIC_KEY } from './public.decorator';

/** Doc 01 §4.1 — the boot sweep's assertion, against the real decorator metadata. */
function sweep(): SweptRoute[] {
  const prototype: object = AuthController.prototype;
  const controllerPath = String(Reflect.getMetadata(PATH_METADATA, AuthController) ?? '');
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
        (key) => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, AuthController),
      ),
      source: `AuthController.${name}`,
    });
  }
  return routes;
}

/** Everything a signed-out visitor must reach: the first factor, the second, and OAuth. */
const PUBLIC_ROUTES = [
  'GET /api/auth/github',
  'GET /api/auth/github/callback',
  'GET /api/auth/google',
  'GET /api/auth/google/callback',
  'GET /api/auth/providers',
  'POST /api/auth/2fa/verify',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/magic-link',
  'POST /api/auth/magic-link/consume',
  'POST /api/auth/password-reset',
  'POST /api/auth/password-reset/confirm',
  'POST /api/auth/refresh',
  'POST /api/auth/register',
  'POST /api/auth/resend-verification',
  'POST /api/auth/verify-email',
];

const AUTHENTICATED_ROUTES = [
  'DELETE /api/auth/sessions/:familyId',
  'GET /api/auth/me',
  'GET /api/auth/sessions',
  'POST /api/auth/2fa/confirm',
  'POST /api/auth/2fa/disable',
  'POST /api/auth/2fa/enrol',
  'POST /api/auth/2fa/recovery-codes',
  'POST /api/auth/sessions/revoke-others',
  'POST /api/auth/switch-org',
];

describe('AuthController route markers', () => {
  const routes = sweep();
  const key = (r: SweptRoute) => `${r.method} ${r.path}`;

  it('registers exactly the auth routes', () => {
    expect(routes.map(key).sort()).toEqual([...PUBLIC_ROUTES, ...AUTHENTICATED_ROUTES].sort());
  });

  it('passes the boot sweep: exactly one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
    for (const route of routes) expect(route.markers).toHaveLength(1);
  });

  it('marks only the pre-session routes @Public()', () => {
    for (const route of routes) {
      expect(route.markers).toEqual([
        PUBLIC_ROUTES.includes(key(route)) ? IS_PUBLIC_KEY : AUTHENTICATED_META,
      ]);
    }
  });

  it('exposes no route to a share-link subject (R21)', () => {
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
