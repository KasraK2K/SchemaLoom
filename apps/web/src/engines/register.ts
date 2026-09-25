'use client';

import { engineFacets, engineUi } from './registry';

/**
 * The whole file, both registries (§16.0). Adding an engine is two more lines here, and this
 * is the only module in `apps/web/src` that may contain an engine id — §16.5's AST check
 * asserts no engine-id literal and no `engineId ===` comparison exists anywhere else.
 *
 * Each `import()` is a real dynamic import, so the facet and the UI plugin are separate
 * chunks: the facet is mandatory for an open project, the UI plugin is not.
 *
 * §16.0 writes the facet loader as `import('@schemaloom/engine-postgresql/static')`. It goes
 * through the UI package's `/facet` re-export instead, because C10's shared eslint rule
 * forbids core from importing an engine and pnpm's isolated linker would not resolve it
 * anyway — `apps/web` declares the engine's UI package, not the engine.
 */
engineFacets.register('postgresql', () => import('@schemaloom/engine-postgresql-ui/facet'));
engineUi.register('postgresql', () => import('@schemaloom/engine-postgresql-ui'));
