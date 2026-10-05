import { routeKey } from './share-link-allowlist';

/** Phase 11 §3; `agent` and `propose` are Phase 21 §3 and §9.4. Every token holds `read`. */
export const API_TOKEN_SCOPES = ['read', 'drift', 'agent', 'propose'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/**
 * Phase 11 §4 — the API-token surface **allow**-list, fenced like `SHARE_LINK_ROUTES`: a
 * token principal reaches only these routes, with the scope named here, and every other
 * route is `404`. `any` means the token's mere existence is enough. No route that writes
 * schema, sharing or settings belongs here, except `agent/proposals`, which only opens a
 * change request a person reviews; `allowlist.spec.ts` pins the list.
 */
export const API_TOKEN_ROUTES: ReadonlyMap<string, ApiTokenScope | 'any'> = new Map([
  ['GET /token', 'any'], // the CLI learns its project, scopes and expiry
  ['GET /projects/:id', 'read'], // name and engine for the CLI's output
  ['GET /projects/:id/ir', 'read'], // `pull --format ir`
  ['POST /projects/:id/exports', 'read'], // `pull` for every server format
  ['GET /exports/:id', 'read'], // poll the export, get its download link
  ['POST /projects/:id/introspect/drift', 'drift'], // `diff`, saved connection only (Q4)
  // Phase 21 §4 — `schemaloom mcp`. Each also checks `ai:use` and the project's AI switch.
  ['GET /projects/:id/agent/outline', 'agent'],
  ['POST /projects/:id/agent/context', 'agent'],
  ['POST /projects/:id/queries/validate', 'agent'],
  ['GET /projects/:id/saved-queries', 'agent'],
  // Roadmap 21b — the ONE write a token reaches, and it only opens a change request.
  ['POST /projects/:id/agent/proposals', 'propose'],
]);

const ALLOWED: ReadonlyMap<string, ApiTokenScope | 'any'> = new Map(
  [...API_TOKEN_ROUTES].map(([entry, scope]) => {
    const [method = '', ...rest] = entry.split(' ');
    return [routeKey(method, rest.join(' ')), scope];
  }),
);

/** The scope a route needs from a token, or `undefined` when tokens can't reach it. */
export const apiTokenRouteScope = (
  method: string,
  path: string,
): ApiTokenScope | 'any' | undefined => ALLOWED.get(routeKey(method, path));

export const isApiTokenRoute = (method: string, path: string): boolean =>
  apiTokenRouteScope(method, path) !== undefined;
