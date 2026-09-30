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
import { IntrospectController } from './introspect.controller';

/** Doc 01 §4.1 — the boot sweep's assertion, run against the real decorator metadata. */
function sweep(): (SweptRoute & { requirement: PermissionRequirement | undefined })[] {
  const controller = IntrospectController;
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
        source: `IntrospectController.${name}`,
        requirement: Reflect.getMetadata(PERM_META, handler) as PermissionRequirement | undefined,
      },
    ];
  });
}

describe('IntrospectController route markers', () => {
  const routes = sweep();

  it('registers preview, apply and drift', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'POST /api/projects/:projectId/introspect/apply',
      'POST /api/projects/:projectId/introspect/drift',
      'POST /api/projects/:projectId/introspect/preview',
    ]);
  });

  it('carries the import atom at project scope (§3.5)', () => {
    for (const route of routes) {
      expect(route.requirement?.atom).toBe('schema:edit');
      expect(route.requirement?.wheres).toEqual([{ project: 'projectId' }]);
    }
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
