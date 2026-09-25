/**
 * `@schemaloom/engine-postgresql-ui/facet` — the client facet, as a default export.
 *
 * §16.0 has `apps/web` register `() => import('@schemaloom/engine-postgresql/static')`. It
 * cannot: under pnpm's isolated linker `apps/web` does not declare `@schemaloom/engine-postgresql`
 * and must not (C10 forbids core importing an engine at all — the shared eslint config enforces
 * it by pattern). This package already depends on the engine and is already the thing core
 * lazily imports for the UI, so it re-exports the facet as its own chunk.
 *
 * Its own module, NOT part of the "." barrel, so the facet chunk and the UI chunk load
 * independently — the facet is mandatory, the UI plugin is not.
 */
export { postgresFacet as default } from '@schemaloom/engine-postgresql/static';
