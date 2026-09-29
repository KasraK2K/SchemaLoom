/* eslint-disable @typescript-eslint/unbound-method --
   `Routes.prototype.someRoute` is never CALLED here: it is the metadata target Nest's
   `Reflector` reads, exactly as `ExecutionContext.getHandler()` hands it to the guard.
   Losing `this` is the whole point. */
import { BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { IS_PUBLIC_KEY, Public } from '../auth/public.decorator';
import {
  AUTHENTICATED_META,
  Authenticated,
  ORG_ROLE_META,
  PERM_META,
  PROJECT_ACCESS_META,
  RequireOrgRole,
  RequirePermission,
  RequirePermissionAll,
  RequireProjectAccess,
  extract,
  markerKeysOn,
  readLocatorId,
  type OrgRoleRequirement,
  type PermissionRequirement,
} from './route-markers';

/**
 * Doc 05 §10.1-§10.2 — the markers are the contract between a controller and the guard,
 * so what is asserted here is the round trip: what the decorator writes is exactly what
 * `Reflector` hands the guard, and the locator resolves the path the doc promises.
 */

class Routes {
  @RequirePermission('schema:edit', { entity: 'id' })
  updateEntity(): string {
    return 'updateEntity';
  }

  @RequirePermissionAll('schema:edit', [
    { entity: 'body.from.entityId' },
    { entity: 'body.to.entityId' },
  ])
  createLink(): string {
    return 'createLink';
  }

  @RequireProjectAccess('projectId')
  getIr(): string {
    return 'getIr';
  }

  @RequireOrgRole('orgId', ['owner', 'admin'])
  createGroup(): string {
    return 'createGroup';
  }

  @Authenticated()
  me(): string {
    return 'me';
  }

  @Public()
  login(): string {
    return 'login';
  }

  unmarked(): string {
    return 'unmarked';
  }

  @RequireProjectAccess('projectId')
  @Authenticated()
  twoMarkers(): string {
    return 'twoMarkers';
  }
}

const reflector = new Reflector();
const read =
  (handler: () => string) =>
  (key: string): unknown =>
    reflector.get<unknown, string>(key, handler);

const asRequest = (partial: Record<string, unknown>): Request => partial as unknown as Request;

describe('route markers round-trip through Reflector', () => {
  it('@RequirePermission stores one locator under PERM_META', () => {
    const meta = reflector.get<PermissionRequirement, string>(
      PERM_META,
      Routes.prototype.updateEntity,
    );
    expect(meta).toEqual({ atom: 'schema:edit', wheres: [{ entity: 'id' }] });
  });

  it('@RequirePermissionAll stores every locator under the same key', () => {
    const meta = reflector.get<PermissionRequirement, string>(
      PERM_META,
      Routes.prototype.createLink,
    );
    expect(meta.atom).toBe('schema:edit');
    expect(meta.wheres).toEqual([{ entity: 'body.from.entityId' }, { entity: 'body.to.entityId' }]);
  });

  it('@RequireProjectAccess stores the param name', () => {
    expect(reflector.get<string, string>(PROJECT_ACCESS_META, Routes.prototype.getIr)).toBe(
      'projectId',
    );
  });

  it('@RequireOrgRole stores the param and the role list', () => {
    const meta = reflector.get<OrgRoleRequirement, string>(
      ORG_ROLE_META,
      Routes.prototype.createGroup,
    );
    expect(meta).toEqual({ param: 'orgId', roles: ['owner', 'admin'] });
  });

  it('@Authenticated and @Public are plain flags', () => {
    expect(reflector.get<boolean, string>(AUTHENTICATED_META, Routes.prototype.me)).toBe(true);
    expect(reflector.get<boolean, string>(IS_PUBLIC_KEY, Routes.prototype.login)).toBe(true);
  });

  it('markerKeysOn reports exactly one marker per annotated route, none for an unmarked one', () => {
    expect(markerKeysOn(read(Routes.prototype.updateEntity))).toEqual([PERM_META]);
    expect(markerKeysOn(read(Routes.prototype.getIr))).toEqual([PROJECT_ACCESS_META]);
    expect(markerKeysOn(read(Routes.prototype.createGroup))).toEqual([ORG_ROLE_META]);
    expect(markerKeysOn(read(Routes.prototype.me))).toEqual([AUTHENTICATED_META]);
    expect(markerKeysOn(read(Routes.prototype.login))).toEqual([IS_PUBLIC_KEY]);
    expect(markerKeysOn(read(Routes.prototype.unmarked))).toEqual([]);
    expect(markerKeysOn(read(Routes.prototype.twoMarkers))).toHaveLength(2);
  });
});

describe('locator extraction', () => {
  const req = asRequest({
    params: { id: 'ent_1', projectId: 'prj_shop' },
    query: { areaId: 'area_1' },
    body: { from: { entityId: 'ent_from' }, to: { entityId: 'ent_to' } },
  });

  it('a bare name reads a route param', () => {
    expect(extract(req, { entity: 'id' })).toEqual({ type: 'entity', id: 'ent_1' });
  });

  it('walks the WHOLE dotted path, not just the first two segments', () => {
    // `spec.split('.', 2)` resolved this to `req.body.from` and threw missing_resource_id.
    expect(extract(req, { entity: 'body.from.entityId' })).toEqual({
      type: 'entity',
      id: 'ent_from',
    });
    expect(extract(req, { entity: 'body.to.entityId' })).toEqual({ type: 'entity', id: 'ent_to' });
  });

  it('reads query too', () => {
    expect(extract(req, { area: 'query.areaId' })).toEqual({ type: 'area', id: 'area_1' });
  });

  it('a missing or non-string id is a 400, never a silent undefined', () => {
    expect(() => extract(req, { entity: 'nope' })).toThrow(BadRequestException);
    expect(() => extract(req, { entity: 'body.from.entityId.deeper' })).toThrow(
      BadRequestException,
    );
    expect(() => readLocatorId(asRequest({ params: { id: '' } }), 'id')).toThrow(
      BadRequestException,
    );
  });
});
