/**
 * Doc 05 §7.12 R21 — the share-link surface **allow**-list.
 *
 * Beyond the atom ceiling (R17 caps a link at `schema:view`), a share-link subject may
 * reach only these surfaces; every other route returns `404`, not `403` — the surface
 * does not exist for that subject.
 *
 * An earlier draft was a DENY-list. A deny-list over a deliberately fat atom is
 * fail-open: `schema:view` grants structure, docs, comments, presence and search in one,
 * so every future surface built on it is a public-link leak by default until somebody
 * remembers to add a row. Inverting it is the same amount of code and fails closed.
 */
export const SHARE_LINK_ROUTES: ReadonlySet<string> = new Set([
  'GET /projects/:id', // the shell: name, engine badge, terminology
  'GET /projects/:id/ir', // redacted
  'GET /projects/:id/docs', // docs-mode read (Phase 5)
  'GET /projects/:id/search', // client-side over the payload it already holds
  'WS  project:subscribe',
]);

/**
 * `METHOD path`, normalised so the allow-list survives the two things that would
 * otherwise silently break it:
 *
 * - the global `/api` prefix, which the doc's entries do not carry;
 * - the param NAME, so `/projects/:id` and `/projects/:projectId` are the same route.
 *   Only a whole `/`-delimited segment starting with `:` is collapsed, which leaves the
 *   `WS  project:subscribe` message name alone.
 */
export function routeKey(method: string, path: string): string {
  const unprefixed = path.replace(/^\/api(?=\/|$)/, '');
  const collapsed = unprefixed.replace(/\/:[^/]+/g, '/:').replace(/\/+$/, '');
  return `${method.toUpperCase()} ${collapsed === '' ? '/' : collapsed}`;
}

const ALLOWED: ReadonlySet<string> = new Set(
  [...SHARE_LINK_ROUTES].map((entry) => {
    const [method = '', ...rest] = entry.trim().split(/\s+/);
    return routeKey(method, rest.join(' '));
  }),
);

export const isShareLinkRoute = (method: string, path: string): boolean =>
  ALLOWED.has(routeKey(method, path));
