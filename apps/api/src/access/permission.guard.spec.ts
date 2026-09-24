/* eslint-disable @typescript-eslint/unbound-method --
   `Routes.prototype.someRoute` is never CALLED here: it is the metadata target Nest's
   `Reflector` reads, exactly as `ExecutionContext.getHandler()` hands it to the guard.
   Losing `this` is the whole point. */
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionAtom } from '@schemaloom/contracts';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Public } from '../auth/public.decorator';
import type { AuthPrincipal } from '../auth/subject';
import { assertAll } from './assertions';
import { PermissionGuard } from './permission.guard';
import type { PermissionResolver } from './permission-resolver.service';
import { canOpenProject } from './resolve';
import type { ResourceIndex } from './resource-index';
import {
  Authenticated,
  RequireOrgRole,
  RequirePermission,
  RequirePermissionAll,
  RequireProjectAccess,
} from './route-markers';
import type { ProjectPermissionMap, ProjectSkeleton } from './types';

/**
 * Doc 05 §10.3-§10.4. The resolver is a double so the CALL COUNT is observable, but
 * `assertAll` and `canOpenProject` are the real functions: the deny shape (§10.3 step 8 —
 * invisible is `404`, visible-but-short is `403`) is the thing under test, and a mocked
 * decision would assert nothing.
 */

const PROJECT = 'prj_shop';
const OTHER_PROJECT = 'prj_other';
const ORG = 'org_acme';

const BULK_IDS = Array.from({ length: 300 }, (_, i) => `ent_${String(i)}`);
const BULK_LOCATORS = BULK_IDS.map((_, i) => ({ entity: `body.ids.${String(i)}` }));

class Routes {
  @Public()
  login(): string {
    return 'login';
  }

  @Authenticated()
  me(): string {
    return 'me';
  }

  @RequireProjectAccess('projectId')
  getIr(): string {
    return 'getIr';
  }

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

  @RequirePermissionAll('schema:edit', BULK_LOCATORS)
  bulkDelete(): string {
    return 'bulkDelete';
  }

  @RequireOrgRole('orgId', ['owner', 'admin'])
  createGroup(): string {
    return 'createGroup';
  }

  unmarked(): string {
    return 'unmarked';
  }
}

function skeletonOf(ids: readonly string[]): ProjectSkeleton {
  const entities = ids.map((id) => ({ id, areaId: null }));
  return {
    generation: 1,
    areaIds: [],
    entities,
    entityById: new Map(entities.map((e) => [e.id, e])),
    entitiesWithRestrictedFields: new Set<string>(),
  };
}

function mapOf(
  atoms: readonly PermissionAtom[],
  overrides: Readonly<Record<string, readonly PermissionAtom[]>> = {},
): ProjectPermissionMap {
  return {
    projectId: PROJECT,
    subjectKey: 'u:ana',
    orgRole: 'member',
    projectAtoms: new Set(atoms),
    areaAtoms: new Map(),
    entityOverrides: new Map(Object.entries(overrides).map(([id, set]) => [id, new Set(set)])),
    restrictedFieldMode: 'mask',
    validUntil: Date.now() + 60_000,
  };
}

const ANA: AuthPrincipal = { kind: 'user', userId: 'ana', orgId: ORG };
const LINK: AuthPrincipal = {
  kind: 'share_link',
  shareLinkId: 'sl_1',
  projectId: PROJECT,
  resourceId: PROJECT,
};

interface RequestOpts {
  auth?: AuthPrincipal;
  method?: string;
  path?: string;
  params?: Record<string, string>;
  body?: unknown;
}

const request = (opts: RequestOpts = {}): Request => {
  const path = opts.path ?? '/api/entities/:id';
  return {
    method: opts.method ?? 'GET',
    baseUrl: '',
    path,
    route: { path },
    params: opts.params ?? {},
    query: {},
    body: opts.body ?? {},
    auth: opts.auth,
  } as unknown as Request;
};

const contextFor = (req: Request, handler: () => string): ExecutionContext =>
  ({
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => Routes,
  }) as unknown as ExecutionContext;

function makeGuard(map: ProjectPermissionMap, skel: ProjectSkeleton, projectId = PROJECT) {
  const resolver = {
    resolveProject: vi.fn().mockResolvedValue(map),
    skeleton: vi.fn().mockResolvedValue(skel),
    canOpenProject: vi.fn(canOpenProject),
    assertAll: vi.fn(assertAll),
    orgRole: vi.fn().mockResolvedValue('member'),
  };
  const index = { projectIdFor: vi.fn().mockResolvedValue(projectId) };
  const guard = new PermissionGuard(
    new Reflector(),
    resolver as unknown as PermissionResolver,
    index as unknown as ResourceIndex,
  );
  return { guard, resolver, index };
}

describe('PermissionGuard — fail closed', () => {
  it('denies an unmarked route even though the boot sweep should have caught it', async () => {
    const { guard } = makeGuard(mapOf(['schema:view']), skeletonOf(['ent_1']));
    await expect(
      guard.canActivate(contextFor(request({ auth: ANA }), Routes.prototype.unmarked)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('lets a @Public() route through with no principal at all', async () => {
    const { guard, resolver } = makeGuard(mapOf([]), skeletonOf([]));
    await expect(
      guard.canActivate(contextFor(request(), Routes.prototype.login)),
    ).resolves.toBe(true);
    expect(resolver.resolveProject).not.toHaveBeenCalled();
  });

  it('denies with NO subject — 401, before any resolve', async () => {
    const { guard, resolver } = makeGuard(mapOf(['schema:view']), skeletonOf(['ent_1']));
    await expect(
      guard.canActivate(
        contextFor(request({ params: { projectId: PROJECT } }), Routes.prototype.getIr),
      ),
    ).rejects.toThrow(UnauthorizedException);
    expect(resolver.resolveProject).not.toHaveBeenCalled();
  });

  it('denies an authenticated user who belongs to no organisation yet', async () => {
    const { guard } = makeGuard(mapOf(['schema:view']), skeletonOf(['ent_1']));
    const orgless: AuthPrincipal = { kind: 'user', userId: 'new', orgId: null };
    await expect(
      guard.canActivate(
        contextFor(
          request({ auth: orgless, params: { projectId: PROJECT } }),
          Routes.prototype.getIr,
        ),
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('@Authenticated() asks for identity only — an org-less user passes', async () => {
    const { guard } = makeGuard(mapOf([]), skeletonOf([]));
    const orgless: AuthPrincipal = { kind: 'user', userId: 'new', orgId: null };
    await expect(
      guard.canActivate(
        contextFor(request({ auth: orgless, path: '/api/auth/me' }), Routes.prototype.me),
      ),
    ).resolves.toBe(true);
  });
});

describe('PermissionGuard — @RequirePermission', () => {
  const skel = skeletonOf(['ent_1']);

  it('allows with a sufficient grant, and attaches the map it already paid for', async () => {
    const map = mapOf(['schema:view', 'schema:edit']);
    const { guard, resolver } = makeGuard(map, skel);
    const req = request({ auth: ANA, method: 'PATCH', params: { id: 'ent_1' } });

    await expect(guard.canActivate(contextFor(req, Routes.prototype.updateEntity))).resolves.toBe(
      true,
    );
    expect(req.access).toEqual({ projectId: PROJECT, map, skel });
    expect(resolver.resolveProject).toHaveBeenCalledTimes(1);
  });

  it('denies an INSUFFICIENT grant with 403 — visible, but short of the atom', async () => {
    const { guard } = makeGuard(mapOf(['schema:view']), skel);
    const req = request({ auth: ANA, method: 'PATCH', params: { id: 'ent_1' } });
    await expect(
      guard.canActivate(contextFor(req, Routes.prototype.updateEntity)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('denies an INVISIBLE resource with 404, not 403 — no existence oracle', async () => {
    const { guard } = makeGuard(mapOf([]), skel);
    const req = request({ auth: ANA, method: 'PATCH', params: { id: 'ent_1' } });
    await expect(
      guard.canActivate(contextFor(req, Routes.prototype.updateEntity)),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('PermissionGuard — @RequirePermissionAll is all-or-nothing (R19)', () => {
  const skel = skeletonOf(['ent_from', 'ent_to']);
  const req = (): Request =>
    request({
      auth: ANA,
      method: 'POST',
      path: '/api/links',
      body: { from: { entityId: 'ent_from' }, to: { entityId: 'ent_to' } },
    });

  it('allows when BOTH endpoints hold the atom', async () => {
    const { guard } = makeGuard(mapOf(['schema:view', 'schema:edit']), skel);
    await expect(guard.canActivate(contextFor(req(), Routes.prototype.createLink))).resolves.toBe(
      true,
    );
  });

  it('fails when ANY locator fails — the second endpoint is view-only', async () => {
    const map = mapOf(['schema:view', 'schema:edit'], { ent_to: ['schema:view'] });
    const { guard } = makeGuard(map, skel);
    await expect(guard.canActivate(contextFor(req(), Routes.prototype.createLink))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('fails when ANY locator is invisible — 404 even though the other is editable', async () => {
    const map = mapOf(['schema:view', 'schema:edit'], { ent_to: [] });
    const { guard } = makeGuard(map, skel);
    await expect(guard.canActivate(contextFor(req(), Routes.prototype.createLink))).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('PermissionGuard — §10.4, guards never loop', () => {
  it('300 entity locators cost ONE resolve, ONE skeleton and ONE id lookup', async () => {
    const { guard, resolver, index } = makeGuard(
      mapOf(['schema:view', 'schema:edit']),
      skeletonOf(BULK_IDS),
    );
    const req = request({
      auth: ANA,
      method: 'POST',
      path: '/api/entities/bulk-delete',
      body: { ids: BULK_IDS },
    });

    await expect(guard.canActivate(contextFor(req, Routes.prototype.bulkDelete))).resolves.toBe(
      true,
    );
    expect(resolver.resolveProject).toHaveBeenCalledTimes(1);
    expect(resolver.skeleton).toHaveBeenCalledTimes(1);
    expect(index.projectIdFor).toHaveBeenCalledTimes(1);
    expect(resolver.assertAll).toHaveBeenCalledTimes(1);
    // One call, 300 refs: N set lookups against the one map, not N resolves.
    expect(resolver.assertAll.mock.calls[0]?.[2]).toHaveLength(300);
  });
});

describe('PermissionGuard — share-link subjects (R21, §7.12)', () => {
  it('refuses a route that is NOT in SHARE_LINK_ROUTES with 404, before any resolve', async () => {
    const { guard, resolver } = makeGuard(mapOf(['schema:view']), skeletonOf(['ent_1']));
    const req = request({
      auth: LINK,
      method: 'POST',
      path: '/api/comments',
      params: { projectId: PROJECT },
    });
    await expect(guard.canActivate(contextFor(req, Routes.prototype.getIr))).rejects.toThrow(
      NotFoundException,
    );
    expect(resolver.resolveProject).not.toHaveBeenCalled();
  });

  it('allows an allow-listed surface for the link’s own project', async () => {
    const { guard } = makeGuard(mapOf(['schema:view']), skeletonOf(['ent_1']));
    const req = request({
      auth: LINK,
      path: '/api/projects/:projectId/ir',
      params: { projectId: PROJECT },
    });
    await expect(guard.canActivate(contextFor(req, Routes.prototype.getIr))).resolves.toBe(true);
  });

  it('refuses a SECOND project even on an allow-listed surface', async () => {
    const { guard, resolver } = makeGuard(mapOf(['schema:view']), skeletonOf(['ent_1']));
    const req = request({
      auth: LINK,
      path: '/api/projects/:projectId/ir',
      params: { projectId: OTHER_PROJECT },
    });
    await expect(guard.canActivate(contextFor(req, Routes.prototype.getIr))).rejects.toThrow(
      NotFoundException,
    );
    expect(resolver.resolveProject).not.toHaveBeenCalled();
  });
});

describe('PermissionGuard — @RequireProjectAccess and @RequireOrgRole', () => {
  it('canOpenProject passes on an area-only grant, and pays for NO skeleton', async () => {
    const map: ProjectPermissionMap = {
      ...mapOf([]),
      areaAtoms: new Map([['area_billing', new Set<PermissionAtom>(['schema:view'])]]),
    };
    const { guard, resolver } = makeGuard(map, skeletonOf(['ent_1']));
    const req = request({ auth: ANA, params: { projectId: PROJECT } });

    await expect(guard.canActivate(contextFor(req, Routes.prototype.getIr))).resolves.toBe(true);
    expect(resolver.skeleton).not.toHaveBeenCalled();
    expect(req.access).toEqual({ projectId: PROJECT, map, skel: null });
  });

  it('canOpenProject fails to 404 on an empty map', async () => {
    const { guard } = makeGuard(mapOf([]), skeletonOf(['ent_1']));
    const req = request({ auth: ANA, params: { projectId: PROJECT } });
    await expect(guard.canActivate(contextFor(req, Routes.prototype.getIr))).rejects.toThrow(
      NotFoundException,
    );
  });

  it('@RequireOrgRole allows a listed role and 403s an unlisted one', async () => {
    const { guard, resolver } = makeGuard(mapOf([]), skeletonOf([]));
    const req = request({ auth: ANA, method: 'POST', params: { orgId: ORG } });

    resolver.orgRole.mockResolvedValue('admin');
    await expect(guard.canActivate(contextFor(req, Routes.prototype.createGroup))).resolves.toBe(
      true,
    );

    resolver.orgRole.mockResolvedValue('member');
    await expect(
      guard.canActivate(contextFor(req, Routes.prototype.createGroup)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('@RequireOrgRole 404s another organisation, without asking the database', async () => {
    const { guard, resolver } = makeGuard(mapOf([]), skeletonOf([]));
    const req = request({ auth: ANA, method: 'POST', params: { orgId: 'org_someone_else' } });
    await expect(guard.canActivate(contextFor(req, Routes.prototype.createGroup))).rejects.toThrow(
      NotFoundException,
    );
    expect(resolver.orgRole).not.toHaveBeenCalled();
  });
});

describe('PermissionGuard — §10.5 denial logging', () => {
  let warn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    warn = vi.fn();
  });

  it('writes one pino warn line per denial, with the §10.5 shape', async () => {
    const { guard } = makeGuard(mapOf(['schema:view']), skeletonOf(['ent_1']));
    (guard as unknown as { logger: { warn: unknown } }).logger = { warn };
    const req = request({ auth: ANA, method: 'PATCH', params: { id: 'ent_1' } });

    await expect(
      guard.canActivate(contextFor(req, Routes.prototype.updateEntity)),
    ).rejects.toThrow(ForbiddenException);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toMatch(/^permission_denied /);
    expect(JSON.parse(line.slice('permission_denied '.length))).toEqual({
      requestId: null,
      subjectKey: 'u:ana',
      projectId: PROJECT,
      refs: ['entity:ent_1'],
      atom: 'schema:edit',
      outcome: 'missing_atom',
    });
  });
});
