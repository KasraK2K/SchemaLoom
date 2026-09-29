import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from '../auth/public.decorator';
import { getPrincipal, toSubject, type AuthPrincipal } from '../auth/subject';
import type { AccessContext } from './access-context';
import { logDenial, type DenialContext } from './denial-log';
import { PermissionResolver } from './permission-resolver.service';
import { ResourceIndex } from './resource-index';
import {
  AUTHENTICATED_META,
  ORG_ROLE_META,
  PERM_META,
  PROJECT_ACCESS_META,
  extract,
  markerKeysOn,
  readLocatorId,
  type OrgRoleRequirement,
  type PermissionRequirement,
} from './route-markers';
import { isShareLinkRoute } from './share-link-allowlist';
import type { Subject } from './types';

/**
 * Doc 05 §10.3 — the SECOND global `APP_GUARD`, behind `JwtAuthGuard` (doc 01 §4.1).
 * `AccessModule` registers it; the order is load-bearing, because this guard reads the
 * principal that guard attached and never parses a cookie itself.
 *
 * Two properties are worth more than the code that produces them:
 *
 * - **It never loops** (§10.4). One route means at most one `resolveProject`, one
 *   `skeleton` and one batched id lookup, whether the request names one entity or three
 *   hundred: the resolver's unit of work is a PROJECT, and every per-resource answer is a
 *   set lookup against the one map.
 * - **Invisible is `404`, not `403`** (§10.3 step 8). A subject who cannot `schema:view`
 *   the resource gets the same body as a subject asking about a resource that does not
 *   exist, so the API is not an existence oracle. That rule lives in `assertAll` and in
 *   `ResourceIndex`, both of which throw the same shape.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PermissionResolver,
    private readonly index: ResourceIndex,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();

    const read = (key: string): unknown =>
      this.reflector.getAllAndOverride<unknown>(key, [context.getHandler(), context.getClass()]);
    const [marker, second] = markerKeysOn(read);

    // Step 1 — fail closed. `RouteSweep` makes this unreachable at boot; it stays here
    // because a guard that trusts a startup check is a guard that opens a route the day
    // that check moves.
    if (marker === undefined || second !== undefined) {
      throw this.deny(req, new ForbiddenException({ code: 'route_not_classified' }), {
        subjectKey: null,
        projectId: null,
        refs: [],
        atom: null,
        outcome: 'route_not_classified',
      });
    }
    if (marker === IS_PUBLIC_KEY) return true;

    // Step 2 — `JwtAuthGuard` has already 401'd a non-public route with no principal.
    // Repeating it costs one property read and removes the assumption.
    const principal = getPrincipal(req);
    if (!principal) {
      throw this.deny(req, new UnauthorizedException({ code: 'NOT_AUTHENTICATED' }), {
        subjectKey: null,
        projectId: null,
        refs: [],
        atom: null,
        outcome: 'no_subject',
      });
    }
    const subjectKey = logKeyOf(principal);

    // Step 5, first half / R21 — a share-link subject may reach only the allow-listed
    // surfaces, and everything else is `404`: the surface does not exist for them.
    if (principal.kind === 'share_link' && !isShareLinkRoute(req.method, routePathOf(req))) {
      throw this.deny(req, notFound(), {
        subjectKey,
        projectId: principal.projectId,
        refs: [],
        atom: null,
        outcome: 'share_link_route',
      });
    }

    if (marker === AUTHENTICATED_META) return true;

    // An authenticated user who belongs to no organisation yet is a real state (the
    // window between registration and the first org). They have no `Subject`, so every
    // resource is invisible — which is the correct answer, not a gap.
    const subject = toSubject(principal);
    if (!subject) {
      throw this.deny(req, notFound(), {
        subjectKey,
        projectId: null,
        refs: [],
        atom: null,
        outcome: 'no_org',
      });
    }

    if (marker === ORG_ROLE_META) {
      const requirement = read(ORG_ROLE_META) as OrgRoleRequirement;
      return this.checkOrgRole(req, subject, subjectKey, requirement);
    }
    if (marker === PROJECT_ACCESS_META) {
      const param = read(PROJECT_ACCESS_META) as string;
      return this.checkProjectAccess(req, subject, subjectKey, param);
    }
    const requirement = read(PERM_META) as PermissionRequirement;
    return this.checkPermission(req, subject, subjectKey, requirement);
  }

  /** §10.2 — org-scoped administration. Never a project resource, so no map is built. */
  private async checkOrgRole(
    req: Request,
    subject: Subject,
    subjectKey: string,
    requirement: OrgRoleRequirement,
  ): Promise<boolean> {
    const orgId = readLocatorId(req, requirement.param);
    const context: DenialContext = {
      subjectKey,
      projectId: null,
      refs: [`organization:${orgId}`],
      atom: null,
      outcome: 'org_role',
    };
    // A share-link subject has no organisation, and a user asking about somebody else's
    // org gets `404`: an org they are not in must not be distinguishable from one that
    // does not exist.
    if (subject.kind !== 'user' || subject.orgId !== orgId) {
      throw this.deny(req, notFound(), context);
    }
    const role = await this.resolver.orgRole(orgId, subject.userId);
    if (role === null) throw this.deny(req, notFound(), context);
    if (!requirement.roles.includes(role)) {
      throw this.deny(
        req,
        new ForbiddenException({ code: 'forbidden_org_role', required: [...requirement.roles] }),
        context,
      );
    }
    return true;
  }

  /**
   * §7.9 / §10.2 — `canOpenProject`, derived from the map alone. **No skeleton**: the
   * sidebar lists 3-20 projects and must not pay for a skeleton per project (§10.4).
   */
  private async checkProjectAccess(
    req: Request,
    subject: Subject,
    subjectKey: string,
    param: string,
  ): Promise<boolean> {
    const projectId = readLocatorId(req, param);
    const context: DenialContext = {
      subjectKey,
      projectId,
      refs: [`project:${projectId}`],
      atom: null,
      outcome: 'not_visible',
    };
    this.assertShareLinkProject(req, subject, projectId, context);

    const map = await this.resolver.resolveProject(subject, projectId);
    if (!this.resolver.canOpenProject(map)) throw this.deny(req, notFound(), context);
    attach(req, { projectId, map, skel: null });
    return true;
  }

  /**
   * §10.1 / §10.3 steps 3-8, and §10.4's whole answer to N+1: N locators cost ONE
   * `resolveProject`, ONE `skeleton` and ONE batched id lookup. `@RequirePermissionAll`
   * is all-or-nothing — any locator that fails fails the request (R19's "both endpoints").
   */
  private async checkPermission(
    req: Request,
    subject: Subject,
    subjectKey: string,
    requirement: PermissionRequirement,
  ): Promise<boolean> {
    const refs = requirement.wheres.map((where) => extract(req, where));
    const projectId = await this.index.projectIdFor(refs);
    const context: DenialContext = {
      subjectKey,
      projectId,
      refs: refs.map((r) => `${r.type}:${r.id}`),
      atom: requirement.atom,
      outcome: 'not_visible',
    };
    this.assertShareLinkProject(req, subject, projectId, context);

    const [map, skel] = await Promise.all([
      this.resolver.resolveProject(subject, projectId),
      this.resolver.skeleton(projectId),
    ]);
    try {
      this.resolver.assertAll(map, skel, refs, requirement.atom);
    } catch (error) {
      throw this.deny(req, toError(error), {
        ...context,
        outcome: error instanceof NotFoundException ? 'not_visible' : 'missing_atom',
      });
    }
    attach(req, { projectId, map, skel });
    return true;
  }

  /**
   * §7.12 step 4 — a share-link session can never address a second project, even if the
   * id is guessed. `404`, because for this subject that project does not exist.
   */
  private assertShareLinkProject(
    req: Request,
    subject: Subject,
    projectId: string,
    context: DenialContext,
  ): void {
    if (subject.kind === 'share_link' && subject.projectId !== projectId) {
      throw this.deny(req, notFound(), { ...context, outcome: 'share_link_project' });
    }
  }

  /** §10.5 — one pino `warn` line per denial, then the exception the caller throws. */
  private deny<E extends Error>(req: Request, error: E, context: DenialContext): E {
    logDenial(this.logger, { requestId: requestIdOf(req), ...context });
    return error;
  }
}

const notFound = (): NotFoundException => new NotFoundException({ code: 'not_found' });

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new ForbiddenException({ code: 'forbidden' });

const attach = (req: Request, context: AccessContext): void => {
  req.access = context;
};

const logKeyOf = (principal: AuthPrincipal): string =>
  principal.kind === 'user' ? `u:${principal.userId}` : `sl:${principal.shareLinkId}`;

/**
 * The route as registered, not as requested: `/api/projects/:id/ir`, never
 * `/api/projects/prj_shop/ir`. Express fills `req.route` before enhancers run; `req.path`
 * is the concrete fallback, which fails CLOSED against the allow-list (a concrete path
 * never matches a `:param` entry).
 */
function routePathOf(req: Request): string {
  const route = (req as { route?: unknown }).route;
  return `${req.baseUrl}${hasStringPath(route) ? route.path : req.path}`;
}

const hasStringPath = (value: unknown): value is { path: string } =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { path?: unknown }).path === 'string';

/** pino-http's per-request id, when the logger is wired. */
function requestIdOf(req: Request): string | null {
  const id: unknown = (req as { id?: unknown }).id;
  if (typeof id === 'string') return id;
  return typeof id === 'number' ? String(id) : null;
}
