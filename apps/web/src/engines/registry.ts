import {
  UnknownEngineError,
  type EngineId,
  type EngineStaticFacet,
} from '@schemaloom/engine-sdk/ui';
import type {
  EngineFacetLoader,
  EngineFacetRegistry,
  EngineUiLoader,
  EngineUiPlugin,
  EngineUiRegistry,
} from './contract';
import { FALLBACK_ENGINE_UI } from './fallback';

/**
 * §16.3 — the registries, and the reason they hold a LOADER rather than a plugin.
 *
 * Doc 01 sketched `Map<engineId, EngineUiPlugin>` with `register.ts` importing each UI package
 * directly. That is a static import, so a deployment with six engines ships six UI bundles to
 * open one project. `() => import(...)` is a real dynamic import: the bundler emits each
 * engine's UI as its own chunk and a user who only opens a PostgreSQL project never downloads
 * the others. Same two files, same one-line registration, deferred chunk.
 *
 * Both registries memoise the PROMISE, not the resolved value: two components mounting in the
 * same tick must not start two fetches, and React's `use()` needs a stable promise identity
 * across renders.
 */

function memoisedLoad<T>(
  cache: Map<EngineId, Promise<T>>,
  engineId: EngineId,
  start: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(engineId);
  if (hit !== undefined) return hit;
  const pending = start();
  cache.set(engineId, pending);
  return pending;
}

export function createEngineUiRegistry(): EngineUiRegistry {
  const loaders = new Map<EngineId, EngineUiLoader>();
  const cache = new Map<EngineId, Promise<EngineUiPlugin>>();

  return {
    register(engineId, loader) {
      loaders.set(engineId, loader);
    },
    load(engineId) {
      return memoisedLoad(cache, engineId, () => {
        const loader = loaders.get(engineId);
        if (loader === undefined) return Promise.resolve(FALLBACK_ENGINE_UI);
        // A bad deploy or an offline chunk degrades the inspector; it never white-screens a
        // project. Caching the resolved fallback is deliberate — retrying a missing chunk on
        // every render would be a request loop.
        return loader().then(
          (module) => module.default,
          (error: unknown) => {
            console.error(`[engines] UI plugin for "${engineId}" failed to load`, error);
            return FALLBACK_ENGINE_UI;
          },
        );
      });
    },
  };
}

export function createEngineFacetRegistry(): EngineFacetRegistry {
  const loaders = new Map<EngineId, EngineFacetLoader>();
  const cache = new Map<EngineId, Promise<EngineStaticFacet>>();

  return {
    register(engineId, loader) {
      loaders.set(engineId, loader);
    },
    load(engineId) {
      return memoisedLoad(cache, engineId, () => {
        const loader = loaders.get(engineId);
        // No fallback here, unlike the UI registry: without capabilities and a type catalog
        // there is nothing to render at all, so this rejects and core shows the
        // "engine not available" state.
        if (loader === undefined) return Promise.reject(new UnknownEngineError(engineId));
        return loader().then((module) => module.default);
      });
    },
  };
}

export const engineFacets: EngineFacetRegistry = createEngineFacetRegistry();
export const engineUi: EngineUiRegistry = createEngineUiRegistry();
