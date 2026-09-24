import { SetMetadata, type CustomDecorator } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'schemaloom:public';

/**
 * Opts a route out of `JwtAuthGuard`, which app.module.ts registers as the FIRST
 * `APP_GUARD` — so the default is authenticated and forgetting this decorator locks a
 * route rather than opening one. Doc 01 §4.1.
 *
 * `@Public()` also exempts the route from CSRF (§4.5): a public route carries no cookie
 * authority, so there is nothing for a cross-site POST to ride on.
 */
export function Public(): CustomDecorator {
  return SetMetadata(IS_PUBLIC_KEY, true);
}
