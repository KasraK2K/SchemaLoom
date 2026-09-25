import type { EngineUiPlugin } from '@schemaloom/engine-postgresql-ui/contract';
import type { EngineId, EngineStaticFacet } from '@schemaloom/engine-sdk/ui';

/**
 * Core's view of the engine UI contract (doc 03 §16.1) — the ONE file in `apps/web` that
 * names the package the contract currently lives in. Everything else imports `@/engines`.
 *
 * WHY THE CONTRACT IS NOT IN `@schemaloom/engine-sdk/ui`, where §16 puts it: typing
 * `ComponentType` needs `react`, and engine-sdk depends on `schema-model` and `zod` and
 * nothing else (C10) because `apps/api` resolves it too. See the header of
 * `packages/engines/postgresql-ui/src/contract.ts`. This re-export is the seam: when
 * engine-sdk can host it, only the specifier below changes.
 *
 * `export type *` — the contract has no runtime exports, and this re-export must never
 * acquire one, or the lazily-loaded engine chunk would be pulled into the main bundle and
 * §16.3's whole point would be lost.
 */
export type * from '@schemaloom/engine-postgresql-ui/contract';

/** §16.3. A loader, not a plugin: `() => import(...)` is what makes the chunk deferred. */
export type EngineUiLoader = () => Promise<{ readonly default: EngineUiPlugin }>;

export interface EngineUiRegistry {
  register(engineId: EngineId, loader: EngineUiLoader): void;
  /** memoised; resolves to `FALLBACK_ENGINE_UI` when unregistered or when the import fails */
  load(engineId: EngineId): Promise<EngineUiPlugin>;
}

/** §16.0. The facet cannot arrive over the wire — `typeCatalog` holds functions and
 *  `propsSchemas` holds zod schemas — so it is imported, through a registry parallel to the
 *  UI one. */
export type EngineFacetLoader = () => Promise<{ readonly default: EngineStaticFacet }>;

export interface EngineFacetRegistry {
  register(engineId: EngineId, loader: EngineFacetLoader): void;
  /**
   * Memoised per session. REJECTS for an unregistered id — unlike the UI registry there is no
   * fallback, because a facet is not optional: without capabilities and a type catalog there
   * is nothing to render. Core catches it and shows the "this project's engine is not
   * available" state.
   */
  load(engineId: EngineId): Promise<EngineStaticFacet>;
}
