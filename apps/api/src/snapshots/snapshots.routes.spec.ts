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
import { ImportJobsController } from '../jobs/import-jobs.controller';
import { ImportController, SnapshotsController } from './snapshots.controller';

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

function sweep(controller: abstract new (...args: never[]) => object = SnapshotsController): Swept[] {
  const prototype: object = controller.prototype;
  const controllerPath = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
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
          Reflect.getMetadata(key, handler) ?? Reflect.getMetadata(key, controller),
      ),
      source: `${controller.name}.${name}`,
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

  it('registers step 19’s five routes, Phase 4’s live diff and delete, Phase 5’s migrations', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'DELETE /api/projects/:projectId/snapshots/:snapshotId',
      'GET /api/projects/:projectId/snapshots',
      'GET /api/projects/:projectId/snapshots/:fromId/diff/:toId',
      'GET /api/projects/:projectId/snapshots/:fromId/migration/:toId',
      'GET /api/projects/:projectId/snapshots/:snapshotId',
      'GET /api/projects/:projectId/snapshots/:snapshotId/diff/live',
      'GET /api/projects/:projectId/snapshots/:snapshotId/migration/live',
      'POST /api/projects/:projectId/snapshots',
      'POST /api/projects/:projectId/snapshots/:snapshotId/restore',
    ]);
  });

  it('declares diff/live BEFORE :fromId/diff/:toId, or `live` would be read as an id', () => {
    const order = routes.map((r) => r.handler);
    expect(order.indexOf('liveDiff')).toBeLessThan(order.indexOf('diff'));
    expect(order.indexOf('liveMigration')).toBeLessThan(order.indexOf('migration'));
  });

  it('generating a migration reads with history:view (the full view is the service’s R21′)', () => {
    expect(atomOf('liveMigration')).toBe('history:view');
    expect(atomOf('migration')).toBe('history:view');
  });

  it('live diff reads with history:view; delete needs schema:edit', () => {
    expect(atomOf('liveDiff')).toBe('history:view');
    expect(atomOf('remove')).toBe('schema:edit');
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

describe('ImportController and ImportJobsController route markers', () => {
  const routes = [...sweep(ImportController), ...sweep(ImportJobsController)];

  it('registers import, preview and the queued path', () => {
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /api/projects/:projectId/import/jobs/:jobId',
      'POST /api/projects/:projectId/import',
      'POST /api/projects/:projectId/import/jobs',
      'POST /api/projects/:projectId/import/preview',
    ]);
  });

  it('passes the boot sweep, and preview carries the same atom as import (L19)', () => {
    expect(() => {
      assertRouteTable(routes);
    }).not.toThrow();
    for (const route of routes) {
      expect(route.markers).toHaveLength(1);
      expect(route.requirement?.atom).toBe('schema:edit');
      expect(route.requirement?.wheres).toEqual([{ project: 'projectId' }]);
    }
    expect(routes.filter((r) => isShareLinkRoute(r.method, r.path))).toEqual([]);
  });
});
