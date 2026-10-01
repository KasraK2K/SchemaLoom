import 'reflect-metadata';
import {
  Inject,
  Injectable,
  Logger,
  RequestMethod,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ApplicationConfig, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { isApiTokenRoute } from './api-token-allowlist';
import {
  AUTHENTICATED_META,
  MARKER_NAMES,
  PERM_META,
  PROJECT_ACCESS_META,
  markerKeysOn,
} from './route-markers';
import { isShareLinkRoute } from './share-link-allowlist';

/**
 * Doc 01 §4.1 and doc 05 §10.3 step 1 — **the boot-time route sweep, and it is
 * mandatory.**
 *
 * There is no implicit default for an undecorated route. An earlier draft said an
 * undecorated non-public route meant "authenticated + org membership"; that is
 * indistinguishable from "somebody forgot a decorator", which is exactly what this
 * exists to catch. A missing or ambiguous marker **fails the process on startup**, which
 * is what makes "every route is protected by guards" structural rather than a review
 * checklist.
 *
 * The second question matters as much as the first: `schema:view` is a deliberately fat
 * atom, so a new surface built on it is a public-link leak by default. Every route in
 * `SHARE_LINK_ROUTES` (R21) must therefore be view-gated — never org-gated, never
 * `@Public()`.
 */

export interface SweptRoute {
  /** `GET`, `POST`, … */
  readonly method: string;
  /** The registered path, global prefix included: `/api/projects/:projectId/ir`. */
  readonly path: string;
  /** Marker metadata keys found on the handler or its controller. */
  readonly markers: readonly string[];
  /** `AuthController.me` — what the failure message points a human at. */
  readonly source: string;
}

/** A share-link subject is capped at `schema:view` (R17) and belongs to no organisation. */
const VIEW_GATED: ReadonlySet<string> = new Set([PERM_META, PROJECT_ACCESS_META]);

/** Phase 11 §4: an API token is fenced to one project, and `GET /token` names none. */
const TOKEN_GATED: ReadonlySet<string> = new Set([...VIEW_GATED, AUTHENTICATED_META]);

const isUnderApi = (path: string): boolean => path === '/api' || path.startsWith('/api/');

const nameOf = (key: string): string => MARKER_NAMES[key] ?? key;

const label = (route: SweptRoute): string => `${route.method} ${route.path} (${route.source})`;

/**
 * The assertion itself, as a pure function over a route table, so the failure is
 * unit-testable without booting Nest.
 *
 * @throws Error listing every problem at once — a boot failure that reports one route at
 *   a time turns "annotate the new controller" into five restarts.
 */
export function assertRouteTable(routes: readonly SweptRoute[]): void {
  const problems: string[] = [];
  for (const route of routes) {
    // `/healthz` and `/readyz` are excluded from the global prefix, so they are outside
    // `/api/**` and outside this sweep — an orchestrator's liveness path is not an API
    // surface. They carry `@Public()` anyway.
    if (!isUnderApi(route.path)) continue;

    const [marker, second] = route.markers;
    if (marker === undefined) {
      problems.push(
        `${label(route)} carries no route marker. Add exactly one of ` +
          `${Object.values(MARKER_NAMES).join(', ')}.`,
      );
      continue;
    }
    if (second !== undefined) {
      problems.push(
        `${label(route)} carries ${String(route.markers.length)} route markers ` +
          `(${route.markers.map(nameOf).join(' + ')}). Exactly one is allowed.`,
      );
      continue;
    }
    if (isShareLinkRoute(route.method, route.path) && !VIEW_GATED.has(marker)) {
      problems.push(
        `${label(route)} is in SHARE_LINK_ROUTES but is marked ${nameOf(marker)}. ` +
          `A share-link subject is capped at schema:view (R17) and has no organisation, ` +
          `so an allow-listed surface must be @RequireProjectAccess() or @RequirePermission().`,
      );
    }
    if (isApiTokenRoute(route.method, route.path) && !TOKEN_GATED.has(marker)) {
      problems.push(
        `${label(route)} is in API_TOKEN_ROUTES but is marked ${nameOf(marker)}. ` +
          `A token route must name its project or be @Authenticated().`,
      );
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `Route sweep failed (doc 01 §4.1, doc 05 §10.3 step 1):\n  - ${problems.join('\n  - ')}`,
    );
  }
}

@Injectable()
export class RouteSweep implements OnApplicationBootstrap {
  private readonly logger = new Logger(RouteSweep.name);

  // Explicit tokens rather than `design:paramtypes`: this provider is exercised by a
  // test that boots a real Nest app under a transpiler with no `emitDecoratorMetadata`,
  // and a boot assertion nobody can test is a boot assertion nobody trusts.
  constructor(
    @Inject(DiscoveryService) private readonly discovery: DiscoveryService,
    @Inject(MetadataScanner) private readonly scanner: MetadataScanner,
    @Inject(ApplicationConfig) private readonly config: ApplicationConfig,
  ) {}

  /**
   * Nest runs this inside `app.init()`, so throwing here aborts `listen()` and the
   * process exits non-zero. That is the point: a deploy failure, not a runtime surprise.
   */
  onApplicationBootstrap(): void {
    const routes = this.collect();
    assertRouteTable(routes);
    const reachable = routes.filter((r) => isShareLinkRoute(r.method, r.path)).length;
    this.logger.log(
      `route sweep: ${String(routes.length)} routes classified, ${String(reachable)} share-link-reachable`,
    );
  }

  /**
   * Walks Nest's controller metadata rather than Express's router stack: the router
   * carries the bound paths but not the handler, and the marker metadata is on the
   * handler.
   *
   * ponytail: an array-valued `@Controller([...])` path resolves to `''` here rather
   * than fanning out. There are none, and a route that vanishes from the sweep would
   * also vanish from the guard's allow-list check — fail-closed either way. Upgrade path
   * if multi-path controllers ever appear: fan out over the array.
   */
  private collect(): SweptRoute[] {
    const prefix = this.config.getGlobalPrefix();
    const excludes: readonly ExcludeRoute[] = this.config.getGlobalPrefixOptions().exclude ?? [];
    const routes: SweptRoute[] = [];

    for (const wrapper of this.discovery.getControllers()) {
      const instance = wrapper.instance as unknown;
      const metatype = wrapper.metatype;
      if (typeof instance !== 'object' || instance === null) continue;
      if (typeof metatype !== 'function') continue;

      const controllerPath = pathOf(readMeta(PATH_METADATA, metatype));
      const prototype = Object.getPrototypeOf(instance) as object;

      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const verb = toRequestMethod(readMeta(METHOD_METADATA, handler));
        if (verb === null) continue;

        const bare = joinPath(controllerPath, pathOf(readMeta(PATH_METADATA, handler)));
        routes.push({
          method: RequestMethod[verb],
          path: isExcluded(bare, verb, excludes) ? bare : joinPath(prefix, bare),
          markers: markerKeysOn((key) => readMeta(key, handler) ?? readMeta(key, metatype)),
          source: `${metatype.name}.${name}`,
        });
      }
    }
    return routes;
  }
}

/** The shape of a normalised `setGlobalPrefix({ exclude })` entry. */
interface ExcludeRoute {
  readonly pathRegex: RegExp;
  readonly requestMethod: RequestMethod;
}

const isExcluded = (
  path: string,
  verb: RequestMethod,
  excludes: readonly ExcludeRoute[],
): boolean =>
  excludes.some(
    (e) =>
      e.pathRegex.test(path) && (e.requestMethod === RequestMethod.ALL || e.requestMethod === verb),
  );

/** A route handler's HTTP verb, or `null` when the method is not a route at all. */
const toRequestMethod = (meta: unknown): RequestMethod | null =>
  typeof meta === 'number' && meta in RequestMethod ? meta : null;

const readMeta = (key: string, target: object): unknown =>
  Reflect.getMetadata(key, target) as unknown;

const pathOf = (meta: unknown): string => (typeof meta === 'string' ? meta : '');

function joinPath(...parts: readonly string[]): string {
  const segments = parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0);
  return `/${segments.join('/')}`;
}
