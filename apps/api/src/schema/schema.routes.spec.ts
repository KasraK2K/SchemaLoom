import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { assertRouteTable, isShareLinkRoute, markerKeysOn, type SweptRoute } from '../access';
import { SchemaController } from './schema.controller';

/**
 * Doc 01 §4.1 — the boot sweep ABORTS THE PROCESS for a route under `/api/**` that
 * carries no marker, or more than one. This runs the same assertion against this
 * controller's real decorator metadata, so a forgotten marker fails here in milliseconds
 * instead of failing a deploy.
 */
function sweep(): SweptRoute[] {
  const prototype: object = SchemaController.prototype;
  const controllerPath = String(Reflect.getMetadata(PATH_METADATA, SchemaController) ?? '');
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
        .replace(/\/$/, ''),
      markers: markerKeysOn(
        (key) =>
          Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, SchemaController),
      ),
      source: `SchemaController.${name}`,
    });
  }
  return routes;
}

describe('SchemaController route markers', () => {
  const routes = sweep();

  it('registers the four routes steps 13-14 own', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /api/projects/:projectId/ir',
      'GET /api/projects/:projectId/ir/canvas',
      'POST /api/projects/:projectId/schema/geometry',
      'POST /api/projects/:projectId/schema/ops',
    ]);
  });

  it('passes the boot sweep: exactly one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
    for (const route of routes) expect(route.markers).toHaveLength(1);
  });

  it('keeps the share-link surface exactly where R21 put it', () => {
    const shareable = routes
      .filter((r) => isShareLinkRoute(r.method, r.path))
      .map((r) => `${r.method} ${r.path}`);
    // `GET .../ir` is allow-listed and view-gated, which the sweep checks. The two write
    // routes and the canvas are NOT, so a share-link subject gets a 404 from
    // `PermissionGuard` before any handler here runs: the surface does not exist for them.
    expect(shareable).toEqual(['GET /api/projects/:projectId/ir']);
  });
});
