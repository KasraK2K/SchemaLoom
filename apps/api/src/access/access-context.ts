import type { Request } from 'express';
import type { ProjectPermissionMap, ProjectSkeleton } from './types';

/**
 * Doc 05 §10.3 step 9 — what `PermissionGuard` attaches for the handler and the response
 * interceptor, so the decision it already paid for is not re-derived downstream.
 *
 * Step 12's `VisibilityContext` is derived from these two by `VisibilityFilter`; it is
 * deliberately not stored here, because it is a function of `(map, skel)` and a second
 * copy is a second thing to keep in sync.
 */
export interface AccessContext {
  readonly projectId: string;
  readonly map: ProjectPermissionMap;
  /**
   * `null` on a `@RequireProjectAccess` route: §7.9/§10.4 — `canOpenProject` reads off
   * the map alone, so the sidebar listing must not pay for a skeleton per project.
   */
  readonly skel: ProjectSkeleton | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `PermissionGuard` on every resource-scoped route. */
      access?: AccessContext;
    }
  }
}

export const getAccessContext = (req: Request): AccessContext | null => req.access ?? null;
