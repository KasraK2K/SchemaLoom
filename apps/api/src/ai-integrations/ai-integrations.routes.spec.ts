import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import {
  AUTHENTICATED_META,
  PERM_META,
  PROJECT_ACCESS_META,
  assertRouteTable,
  isShareLinkRoute,
  markerKeysOn,
  type SweptRoute,
} from '../access';
import {
  AiAbilitiesController,
  MyAiIntegrationsController,
  OrgAiIntegrationsController,
  ProjectAiController,
} from './ai-integrations.controller';

const CONTROLLERS = [
  OrgAiIntegrationsController,
  MyAiIntegrationsController,
  ProjectAiController,
  AiAbilitiesController,
];

function sweep(): SweptRoute[] {
  const routes: SweptRoute[] = [];
  for (const controller of CONTROLLERS) {
    const prefix: unknown = Reflect.getMetadata(PATH_METADATA, controller);
    const prototype = controller.prototype as unknown as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];
      if (name === 'constructor' || typeof handler !== 'function') continue;
      const verb: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
      if (typeof verb !== 'number') continue;
      const path: unknown = Reflect.getMetadata(PATH_METADATA, handler);
      routes.push({
        method: RequestMethod[verb] ?? 'UNKNOWN',
        path: `/api/${typeof prefix === 'string' ? prefix : ''}/${typeof path === 'string' ? path : ''}`
          .replace(/\/+/g, '/')
          .replace(/\/$/, ''),
        markers: markerKeysOn((key) => Reflect.getMetadata(key, handler)),
        source: `${controller.name}.${name}`,
      });
    }
  }
  return routes;
}

describe('AI integrations route markers', () => {
  const routes = sweep();
  const table = Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r.markers]));

  it('serves exactly the roadmap 24 §5.1 routes', () => {
    expect(Object.keys(table).sort()).toEqual([
      'DELETE /api/me/ai/choices',
      'DELETE /api/me/ai/integrations/:id',
      'DELETE /api/organizations/:orgSlug/ai/choices',
      'DELETE /api/organizations/:orgSlug/ai/integrations/:id',
      'DELETE /api/organizations/:orgSlug/ai/integrations/:id/grants/:grantId',
      'DELETE /api/projects/:projectId/ai/choices',
      'GET /api/ai/abilities',
      'GET /api/me/ai/choices',
      'GET /api/me/ai/integrations',
      'GET /api/organizations/:orgSlug/ai/choices',
      'GET /api/organizations/:orgSlug/ai/integrations',
      'GET /api/organizations/:orgSlug/ai/integrations/:id/grants',
      'GET /api/projects/:projectId/ai/choices',
      'GET /api/projects/:projectId/ai/options',
      'PATCH /api/me/ai/integrations/:id',
      'PATCH /api/organizations/:orgSlug/ai/integrations/:id',
      'POST /api/me/ai/integrations',
      'POST /api/me/ai/integrations/:id/test',
      'POST /api/organizations/:orgSlug/ai/integrations',
      'POST /api/organizations/:orgSlug/ai/integrations/:id/grants',
      'POST /api/organizations/:orgSlug/ai/integrations/:id/test',
      'PUT /api/me/ai/choices',
      'PUT /api/organizations/:orgSlug/ai/choices',
      'PUT /api/projects/:projectId/ai/choices',
    ]);
  });

  it('passes the boot sweep with one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
  });

  it('marks project choices with sharing:manage and options with project access', () => {
    expect(table['PUT /api/projects/:projectId/ai/choices']).toEqual([PERM_META]);
    expect(table['GET /api/projects/:projectId/ai/options']).toEqual([PROJECT_ACCESS_META]);
    expect(table['GET /api/me/ai/integrations']).toEqual([AUTHENTICATED_META]);
  });

  it('exposes nothing to a share-link subject (R21)', () => {
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
