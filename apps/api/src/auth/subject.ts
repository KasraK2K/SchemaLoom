import type { Request } from 'express';

/**
 * Doc 05 §7.1 verbatim. There is no `guest` kind (guest is an org role) and no `group`
 * kind (group membership is expanded inside the resolver).
 *
 * Structurally identical to the `Subject` the permission resolver declares in
 * `src/access/`; TypeScript matches them by shape, so neither module has to import the
 * other and doc 01 §4's "AuthModule imports AccessModule, never the reverse" holds.
 */
export type Subject =
  | { kind: 'user'; userId: string; orgId: string }
  | { kind: 'share_link'; shareLinkId: string; projectId: string };

export function subjectKey(s: Subject): string {
  return s.kind === 'user' ? `u:${s.userId}` : `sl:${s.shareLinkId}`;
}

/**
 * What `JwtAuthGuard` attaches. Wider than `Subject` in exactly two places, both of
 * which the resolver does not need but the routes do:
 *
 * - `orgId` is nullable. A user who has authenticated but belongs to no organisation
 *   yet (the window between registration and the first org) is a real state, and
 *   `GET /auth/me` must answer for them. They have no `Subject`, so `PermissionGuard`
 *   denies every resource — which is correct, not a gap.
 * - a share-link principal carries `resourceId`, the landing route's target (§7.12).
 */
export type AuthPrincipal =
  | { kind: 'user'; userId: string; orgId: string | null }
  | { kind: 'share_link'; shareLinkId: string; projectId: string; resourceId: string };

export function toSubject(principal: AuthPrincipal): Subject | null {
  if (principal.kind === 'share_link') {
    return {
      kind: 'share_link',
      shareLinkId: principal.shareLinkId,
      projectId: principal.projectId,
    };
  }
  return principal.orgId === null
    ? null
    : { kind: 'user', userId: principal.userId, orgId: principal.orgId };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `JwtAuthGuard`. Absent on `@Public()` routes reached without cookies. */
      auth?: AuthPrincipal;
      /** A share-link session held BESIDE a signed-in user (`auth` is the user). Used only
       *  by `PermissionGuard`, only when the user can't see the project themselves. */
      shareAuth?: Extract<AuthPrincipal, { kind: 'share_link' }>;
    }
  }
}

export function getPrincipal(req: Request): AuthPrincipal | null {
  return req.auth ?? null;
}

/** What `PermissionGuard` calls. `null` means "no subject" — reject. */
export function getSubject(req: Request): Subject | null {
  const principal = req.auth;
  return principal ? toSubject(principal) : null;
}
