import { describe, expect, it } from 'vitest';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { AUTHENTICATED_META, ORG_ROLE_META, PERM_META, PROJECT_ACCESS_META } from './route-markers';
import { assertRouteTable, type SweptRoute } from './route-sweep';
import { isShareLinkRoute, routeKey } from './share-link-allowlist';

/**
 * Doc 01 §4.1 / doc 05 §10.3 step 1. The sweep's whole value is that it is a REAL
 * assertion with a real failure: a missing or ambiguous marker stops the process, so
 * "every route is protected by guards" is structural rather than a review checklist.
 */

const route = (over: Partial<SweptRoute> = {}): SweptRoute => ({
  method: 'GET',
  path: '/api/projects/:projectId',
  markers: [PROJECT_ACCESS_META],
  source: 'ProjectsController.get',
  ...over,
});

const sweep = (routes: readonly SweptRoute[]) => (): void => {
  assertRouteTable(routes);
};

describe('assertRouteTable', () => {
  it('passes a table where every /api route carries exactly one marker', () => {
    expect(
      sweep([
        route(),
        route({ method: 'POST', path: '/api/auth/login', markers: [IS_PUBLIC_KEY] }),
        route({ path: '/api/auth/me', markers: [AUTHENTICATED_META] }),
        route({ method: 'PATCH', path: '/api/entities/:id', markers: [PERM_META] }),
      ]),
    ).not.toThrow();
  });

  it('THROWS on a route with no marker, and names it', () => {
    expect(sweep([route({ path: '/api/comments', markers: [], source: 'C.create' })])).toThrow(
      /C\.create[\s\S]*no route marker/,
    );
  });

  it('THROWS on a route with two markers', () => {
    expect(
      sweep([route({ markers: [IS_PUBLIC_KEY, PROJECT_ACCESS_META], source: 'C.both' })]),
    ).toThrow(/C\.both[\s\S]*2 route markers/);
  });

  it('reports every problem in one failure, not one restart at a time', () => {
    const thrown = sweep([
      route({ path: '/api/a', markers: [], source: 'A.one' }),
      route({ path: '/api/b', markers: [PERM_META, ORG_ROLE_META], source: 'B.two' }),
    ]);
    expect(thrown).toThrow(/A\.one/);
    expect(thrown).toThrow(/B\.two/);
  });

  it('leaves /healthz and /readyz alone — they are outside /api/**', () => {
    expect(
      sweep([
        { method: 'GET', path: '/healthz', markers: [], source: 'HealthController.live' },
        { method: 'GET', path: '/readyz', markers: [], source: 'HealthController.ready' },
      ]),
    ).not.toThrow();
  });

  it('THROWS when a SHARE_LINK_ROUTES surface is not view-gated (R21)', () => {
    const orgGated = route({
      path: '/api/projects/:projectId/ir',
      markers: [ORG_ROLE_META],
      source: 'P.ir',
    });
    const publicGated = route({
      path: '/api/projects/:projectId/ir',
      markers: [IS_PUBLIC_KEY],
      source: 'P.ir',
    });
    expect(sweep([orgGated])).toThrow(/SHARE_LINK_ROUTES/);
    expect(sweep([publicGated])).toThrow(/SHARE_LINK_ROUTES/);
  });

  it('accepts an allow-listed surface that is view-gated', () => {
    expect(
      sweep([route({ path: '/api/projects/:projectId/ir', markers: [PROJECT_ACCESS_META] })]),
    ).not.toThrow();
  });
});

describe('SHARE_LINK_ROUTES matching', () => {
  it('drops the global prefix and ignores the param NAME', () => {
    expect(routeKey('get', '/api/projects/:projectId/ir')).toBe('GET /projects/:/ir');
    expect(isShareLinkRoute('GET', '/api/projects/:id/ir')).toBe(true);
    expect(isShareLinkRoute('GET', '/api/projects/:projectId/ir')).toBe(true);
    expect(isShareLinkRoute('GET', '/api/projects/:projectId')).toBe(true);
  });

  it('is an allow-list: anything not listed is out', () => {
    expect(isShareLinkRoute('POST', '/api/comments')).toBe(false);
    expect(isShareLinkRoute('GET', '/api/projects/:id/activity')).toBe(false);
    // Same path, unsafe method: the allow-list is keyed by method too.
    expect(isShareLinkRoute('DELETE', '/api/projects/:id')).toBe(false);
  });

  it('a concrete path never matches a :param entry, so the guard fails closed', () => {
    expect(isShareLinkRoute('GET', '/api/projects/prj_shop/ir')).toBe(false);
  });
});
