import type { ReactNode } from 'react';

/**
 * Server Component. Project metadata + the engine descriptor ONLY (doc 01 §5.2):
 * small, stable, and needed by every child route including /settings.
 *
 * It must never fetch the IR. The IR is fetched by the canvas route's own query so
 * that a user who navigated to /settings does not pay for it, and so that the query
 * can later become incremental without touching the route tree.
 */
export default function ProjectLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
