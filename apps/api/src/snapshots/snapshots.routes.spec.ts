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
import { SnapshotsController } from './snapshots.controller';

/**
 * Doc 01 §4.1 — the boot sweep ABORTS THE PROCESS for a route under `/api/**` that carries
 * no marker, or more than one. This runs the same assertion against this controller's real
 * decorator metadata, so a forgotten marker fails here in milliseconds instead of failing a
 * deploy.
 */
interface Swept extends SweptRoute {
  readonly handler: string;
  readonly requirement: PermissionRequirement | undefined;
}

function sweep(): Swept[] {
  const prototype: object = SnapshotsController.prototype;
  const controllerPath = String(Reflect.getMetadata(PATH_METADATA, SnapshotsController) ?? '');
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
        .replace(/\/$/, ''),
      markers: markerKeysOn(
        (key) =>
          Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, SnapshotsController),
      ),
      source: `SnapshotsController.${name}`,
      handler: name,
      requirement: Reflect.getMetadata(PERM_META, handler) as PermissionRequirement | undefined,
    });
  }
  return routes;
}

describe('SnapshotsController route markers', () => {
  const routes = sweep();
  const atomOf = (handler: string): string | undefined =>
    routes.find((r) => r.handler === handler)?.requirement?.atom;

  it('registers the five routes step 19 owns', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /api/projects/:projectId/snapshots',
      'GET /api/projects/:projectId/snapshots/:fromId/diff/:toId',
      'GET /api/projects/:projectId/snapshots/:snapshotId',
      'POST /api/projects/:projectId/snapshots',
      'POST /api/projects/:projectId/snapshots/:snapshotId/restore',
    ]);
  });

  it('passes the boot sweep: exactly one marker each', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
    for (const route of routes) expect(route.markers).toHaveLength(1);
  });

  it('CREATING a snapshot requires schema:edit, not merely history:view', () => {
    // Doc 05 §5's atom table is explicit: `history:view` lists and reads; **creating** a
    // snapshot is `schema:edit`. An auditor who may read history has no business minting
    // rows on the project.
    expect(atomOf('create')).toBe('schema:edit');
    expect(atomOf('restore')).toBe('schema:edit');
  });

  it('reading and diffing require history:view', () => {
    expect(atomOf('list')).toBe('history:view');
    expect(atomOf('read')).toBe('history:view');
    expect(atomOf('diff')).toBe('history:view');
  });

  it('evaluates every atom at PROJECT scope (doc 02 §11, open question Q8)', () => {
    // The blob is opaque, so `VisibilityFilter` cannot filter a snapshot list: an
    // area-scoped editor who could list snapshots would read every entity name they
    // cannot see. An area- or entity-scoped principal therefore cannot use history at
    // all — the accepted design, not a bug to work around.
    for (const route of routes) {
      expect(route.requirement?.wheres).toEqual([{ project: 'projectId' }]);
    }
  });

  it('exposes nothing to a share-link subject (R21)', () => {
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
