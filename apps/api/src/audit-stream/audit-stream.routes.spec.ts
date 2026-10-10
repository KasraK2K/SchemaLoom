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
import { AuditStreamController } from './audit-stream.controller';

/** Doc 01 §4.1 — the boot sweep's assertion, against the real decorator metadata. */
function sweep(): SweptRoute[] {
  const prototype: object = AuditStreamController.prototype;
  const controllerPath = String(Reflect.getMetadata(PATH_METADATA, AuditStreamController) ?? '');
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
        (key) =>
          Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, AuditStreamController),
      ),
      source: `AuditStreamController.${name}`,
    });
  }
  return routes;
}

/** Roadmap 14d §4: four owner routes; the service checks the role (404 for anyone else). */
const ROUTES = [
  'DELETE /api/organizations/:orgSlug/audit-stream',
  'GET /api/organizations/:orgSlug/audit-stream',
  'POST /api/organizations/:orgSlug/audit-stream/test',
  'PUT /api/organizations/:orgSlug/audit-stream',
];

const key = (r: SweptRoute): string => `${r.method} ${r.path}`;

describe('AuditStreamController route markers', () => {
  const routes = sweep();

  it('registers exactly the audit stream routes', () => {
    expect(routes.map(key).sort()).toEqual([...ROUTES].sort());
  });

  it('passes the boot sweep: exactly one marker each, @Authenticated', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
    for (const route of routes) expect(route.markers).toEqual([AUTHENTICATED_META]);
  });

  it('exposes no route to a share-link subject (R21)', () => {
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
