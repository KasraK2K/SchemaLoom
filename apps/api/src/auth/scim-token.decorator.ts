import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const SCIM_TOKEN_META = 'schemaloom:scimToken';

/**
 * Roadmap 14b (`docs/phase14/DIRECTORY-SYNC.md` §1.2) — a SCIM route: the caller is an
 * IdP's provisioning client holding `Bearer slscim_…`, not a person. `JwtAuthGuard`
 * resolves the token to its connection (and so its org) instead of a user, and no other
 * marker accepts that principal. Only `/api/scim/v2/**` may carry it (`RouteSweep` checks).
 *
 * Lives beside `@Public()` for the same reason: `JwtAuthGuard` reads it, and `src/auth`
 * never imports from `src/access`.
 */
export const RequireScimToken = (): CustomDecorator => SetMetadata(SCIM_TOKEN_META, true);
