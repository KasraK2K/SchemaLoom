import { routeKey } from './share-link-allowlist';

/** Phase 11 §3. A token holds one or both. */
export const API_TOKEN_SCOPES = ['read', 'drift'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

/**
 * Phase 11 §4 — the API-token surface **allow**-list, fenced like `SHARE_LINK_ROUTES`: a
 * token principal reaches only these routes, with the scope named here, and every other
 * route is `404`. `any` means the token's mere existence is enough. No route that writes
 * schema, sharing or settings belongs here; `api-token-allowlist.spec.ts` pins the list.
 */
export const API_TOKEN_ROUTES: ReadonlyMap<string, ApiTokenScope | 'any'> = new Map([
  ['GET /token', 'any'], // the CLI learns its project, scopes and expiry
  ['GET /projects/:id', 'read'], // name and engine for the CLI's output
  ['GET /projects/:id/ir', 'read'], // `pull --format ir`
  ['POST /projects/:id/exports', 'read'], // `pull` for every server format
  ['GET /exports/:id', 'read'], // poll the export, get its download link
  ['POST /projects/:id/introspect/drift', 'drift'], // `diff`, saved connection only (Q4)
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
