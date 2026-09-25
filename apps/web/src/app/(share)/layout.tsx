import type { ReactNode } from 'react';

/**
 * `(share)` — public, read-only share-link viewer. RESERVED, no routes in Phase 1
 * (doc 01 §5.1). The group exists now so that when `/s/[token]` lands in Phase 3
 * nobody puts it inside `(app)` and silently inherits an authenticated layout and a
 * session fetch that a share-link visitor cannot satisfy.
 *
 * Two things must happen together when the first route is added here: the page, and
 * the `|s` exclusion in the middleware matcher.
 */
export default function ShareLayout({ children }: { children: ReactNode }) {
  return <div className="min-h-dvh bg-canvas">{children}</div>;
}
