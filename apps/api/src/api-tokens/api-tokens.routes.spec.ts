import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import {
  PERM_META,
  assertRouteTable,
  isApiTokenRoute,
  isShareLinkRoute,
  markerKeysOn,
  type PermissionRequirement,
  type SweptRoute,
} from '../access';
import { ApiTokensController } from './api-tokens.controller';

/** Doc 01 §4.1 — the boot sweep's assertion, run against the real decorator metadata. */
function sweep(): (SweptRoute & { requirement: PermissionRequirement | undefined })[] {
  const controller = ApiTokensController;
  const prototype = controller.prototype as unknown as Record<string, unknown>;
  const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
  return Object.getOwnPropertyNames(prototype).flatMap((name) => {
    const handler = prototype[name];
    if (name === 'constructor' || typeof handler !== 'function') return [];
    const verb: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
    if (typeof verb !== 'number') return [];
    const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
    return [
      {
        method: RequestMethod[verb] ?? 'UNKNOWN',
        path: `/api/${base}/${typeof path === 'string' ? path : ''}`.replace(/\/+/g, '/'),
        markers: markerKeysOn(
          (key) => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller),
        ),
        source: `ApiTokensController.${name}`,
        requirement: Reflect.getMetadata(PERM_META, handler) as PermissionRequirement | undefined,
      },
    ];
  });
}

describe('ApiTokensController route markers', () => {
  const routes = sweep();

  it('registers self, mine, create, the project list and revoke', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'DELETE /api/api-tokens/:id',
      'GET /api/me/api-tokens',
      'GET /api/projects/:projectId/api-tokens',
      'GET /api/token',
      'POST /api/projects/:projectId/api-tokens',
    ]);
  });

  it('lets only sharing managers list a project’s tokens (§6)', () => {
    const list = routes.find(
      (r) => r.path === '/api/projects/:projectId/api-tokens' && r.method === 'GET',
    );
    expect(list?.requirement).toEqual({
      atom: 'sharing:manage',
      wheres: [{ project: 'projectId' }],
    });
  });

  it('passes the boot sweep: exactly one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
    for (const route of routes) expect(route.markers).toHaveLength(1);
  });

  it('a token can reach only GET /token here, and a share link nothing', () => {
    expect(routes.filter((r) => isApiTokenRoute(r.method, r.path)).map((r) => r.path)).toEqual([
      '/api/token',
    ]);
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
