import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import {
  PERM_META,
  assertRouteTable,
  isShareLinkRoute,
  markerKeysOn,
  type PermissionRequirement,
  type SweptRoute,
} from '../access';
import { SavedConnectionController } from './saved-connection.controller';

/** Doc 01 §4.1 — the boot sweep's assertion, run against the real decorator metadata. */
function sweep(): (SweptRoute & { requirement: PermissionRequirement | undefined })[] {
  const controller = SavedConnectionController;
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
        source: `SavedConnectionController.${name}`,
        requirement: Reflect.getMetadata(PERM_META, handler) as PermissionRequirement | undefined,
      },
    ];
  });
}

describe('SavedConnectionController route markers', () => {
  const routes = sweep();

  it('registers view, save and forget', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'DELETE /api/projects/:projectId/connection/',
      'GET /api/projects/:projectId/connection/',
      'PUT /api/projects/:projectId/connection/',
    ]);
  });

  it('lets editors see it and only managers change it (6c §3)', () => {
    const atomOf = (method: string) => routes.find((r) => r.method === method)?.requirement?.atom;
    expect(atomOf('GET')).toBe('schema:edit');
    expect(atomOf('PUT')).toBe('sharing:manage');
    expect(atomOf('DELETE')).toBe('sharing:manage');
    for (const route of routes)
      expect(route.requirement?.wheres).toEqual([{ project: 'projectId' }]);
  });

  it('passes the boot sweep: exactly one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
    for (const route of routes) expect(route.markers).toHaveLength(1);
  });

  it('exposes nothing to a share-link subject (R21)', () => {
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
