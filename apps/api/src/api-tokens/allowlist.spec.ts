import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import {
  API_TOKEN_ROUTES,
  AUTHENTICATED_META,
  ORG_ROLE_META,
  PROJECT_ACCESS_META,
  apiTokenRouteScope,
  assertRouteTable,
  markerKeysOn,
  routeKey,
  type SweptRoute,
} from '../access';
import { AiController } from '../ai/ai.controller';
import { IS_PUBLIC_KEY } from '../auth';
import { IntrospectController } from '../introspect/introspect.controller';
import { ExportsController } from '../jobs/exports.controller';
import { ProjectsController } from '../projects/projects.controller';
import { SavedQueriesController } from '../saved-queries/saved-queries.controller';
import { SchemaController } from '../schema/schema.controller';
import { ApiTokensController } from './api-tokens.controller';

/** The real routes of every controller the allow-list names. */
function sweep(controllers: readonly (abstract new (...args: never[]) => unknown)[]): SweptRoute[] {
  return controllers.flatMap((controller) => {
    const prototype = controller.prototype as Record<string, unknown>;
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
          source: `${controller.name}.${name}`,
        },
      ];
    });
  });
}

describe('API_TOKEN_ROUTES (Phase 11 §4)', () => {
  it('is exactly the reviewed list: no write but the agent proposal (a change request)', () => {
    expect([...API_TOKEN_ROUTES]).toEqual([
      ['GET /token', 'any'],
      ['GET /projects/:id', 'read'],
      ['GET /projects/:id/ir', 'read'],
      ['POST /projects/:id/exports', 'read'],
      ['GET /exports/:id', 'read'],
      ['POST /projects/:id/introspect/drift', 'drift'],
      ['GET /projects/:id/agent/outline', 'agent'],
      ['POST /projects/:id/agent/context', 'agent'],
      ['POST /projects/:id/queries/validate', 'agent'],
      ['GET /projects/:id/saved-queries', 'agent'],
      ['POST /projects/:id/agent/proposals', 'propose'],
    ]);
  });

  it('names only routes that exist, so a rename cannot silently drop one', () => {
    const routes = sweep([
      ApiTokensController,
      ProjectsController,
      SchemaController,
      ExportsController,
      IntrospectController,
      AiController,
      SavedQueriesController,
    ]);
    const present = new Set(routes.map((r) => routeKey(r.method, r.path)));
    for (const entry of API_TOKEN_ROUTES.keys()) {
      const [method = '', path = ''] = entry.split(' ');
      expect(present, entry).toContain(routeKey(method, path));
    }
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
  });

  it('matches registered paths whatever the param name and prefix', () => {
    expect(apiTokenRouteScope('GET', '/api/projects/:projectId/ir')).toBe('read');
    expect(apiTokenRouteScope('POST', '/api/projects/:projectId/introspect/drift')).toBe('drift');
    expect(apiTokenRouteScope('PATCH', '/api/projects/:projectId')).toBeUndefined();
    // A concrete path never matches a `:param` entry: fail closed.
    expect(apiTokenRouteScope('GET', '/api/projects/prj_1/ir')).toBeUndefined();
  });

  it('the boot sweep refuses a token route that is public or org-gated', () => {
    const route = (marker: string): SweptRoute[] => [
      { method: 'GET', path: '/api/projects/:projectId/ir', markers: [marker], source: 'X.ir' },
    ];
    expect(() => {
      assertRouteTable(route(PROJECT_ACCESS_META));
    }).not.toThrow();
    expect(() => {
      assertRouteTable(route(IS_PUBLIC_KEY));
    }).toThrow(/API_TOKEN_ROUTES/);
    expect(() => {
      assertRouteTable(route(ORG_ROLE_META));
    }).toThrow(/API_TOKEN_ROUTES/);
    expect(() => {
      assertRouteTable([
        { method: 'GET', path: '/api/token', markers: [AUTHENTICATED_META], source: 'X.t' },
      ]);
    }).not.toThrow();
  });
});
