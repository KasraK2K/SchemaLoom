import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import {
  ORG_ROLE_META,
  PERM_META,
  PROJECT_ACCESS_META,
  assertRouteTable,
  isShareLinkRoute,
  markerKeysOn,
  type OrgRoleRequirement,
  type SweptRoute,
} from '../access';
import { ProjectsController } from './projects.controller';

/**
 * Doc 01 §4.1 — the boot sweep ABORTS THE PROCESS for a route under `/api/**` with no
 * marker, or more than one, or an allow-listed route that is not view-gated. This runs
 * the same assertion against this controller's real decorator metadata, so a wrong marker
 * fails here in milliseconds instead of failing a deploy.
 */
interface Swept extends SweptRoute {
  readonly handler: string;
  readonly orgRole: OrgRoleRequirement | undefined;
}

function sweep(): Swept[] {
  const prototype: object = ProjectsController.prototype;
  const controllerPath = String(Reflect.getMetadata(PATH_METADATA, ProjectsController) ?? '');
  const routes: Swept[] = [];

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
        (key) => Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, ProjectsController),
      ),
      source: `ProjectsController.${name}`,
      handler: name,
      orgRole: Reflect.getMetadata(ORG_ROLE_META, handler) as OrgRoleRequirement | undefined,
    });
  }
  return routes;
}

describe('ProjectsController route markers', () => {
  const routes = sweep();
  const route = (handler: string): Swept | undefined => routes.find((r) => r.handler === handler);

  it('registers the project shell, create, rename and delete routes', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'DELETE /api/projects/:projectId',
      'GET /api/projects/:projectId',
      'PATCH /api/projects/:projectId',
      'POST /api/projects',
    ]);
  });

  it('gates rename and delete on sharing:manage at the project, not share-link reachable', () => {
    for (const handler of ['update', 'remove']) {
      const r = route(handler);
      expect(r?.markers).toEqual([PERM_META]);
      expect(r && isShareLinkRoute(r.method, r.path)).toBe(false);
    }
  });

  it('passes the boot sweep: exactly one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
    for (const r of routes) expect(r.markers).toHaveLength(1);
  });

  it('view-gates the shell, because it is share-link reachable (R21)', () => {
    // `GET /projects/:id` is in SHARE_LINK_ROUTES. The sweep REFUSES to boot a process in
    // which an allow-listed route is org-gated or @Public(), so this marker is forced.
    const shell = route('detail');
    expect(shell && isShareLinkRoute(shell.method, shell.path)).toBe(true);
    expect(shell?.markers).toEqual([PROJECT_ACCESS_META]);
  });

  it('org-gates creation at member and above, never guest (doc 05 §3.2)', () => {
    const create = route('create');
    expect(create?.markers).toEqual([ORG_ROLE_META]);
    // The locator must read the BODY: creation names no project, and the guard does no
    // database lookups, so a workspace id alone could not be org-gated at all.
    expect(create?.orgRole?.param).toBe('body.organizationId');
    expect([...(create?.orgRole?.roles ?? [])].sort()).toEqual(['admin', 'member', 'owner']);
    expect(create?.orgRole?.roles).not.toContain('guest');
  });

  it('exposes creation to no share-link subject', () => {
    const create = route('create');
    expect(create && isShareLinkRoute(create.method, create.path)).toBe(false);
  });
});
