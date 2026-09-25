'use client';

import type { EngineId, EngineStaticFacet } from '@schemaloom/engine-sdk/ui';
import { createContext, use, useContext, type ReactNode } from 'react';
import type { EngineUiPlugin } from './contract';
import { engineFacets, engineUi } from './registry';

export interface EngineContextValue {
  readonly facet: EngineStaticFacet;
  readonly ui: EngineUiPlugin;
}

const EngineContext = createContext<EngineContextValue | null>(null);

/** Memoised per engine id so `use()` sees the same promise identity on every render. */
const pending = new Map<EngineId, Promise<EngineContextValue>>();

function engineContextPromise(engineId: EngineId): Promise<EngineContextValue> {
  const hit = pending.get(engineId);
  if (hit !== undefined) return hit;
  // Both registries, in parallel: the UI plugin never gates on the facet, and the facet's
  // chunk is the smaller of the two.
  const promise = Promise.all([engineFacets.load(engineId), engineUi.load(engineId)]).then(
    ([facet, ui]) => ({ facet, ui }),
  );
  pending.set(engineId, promise);
  return promise;
}

/** The raw provider. `EngineProvider` uses it, and so does anything that already holds a
 *  resolved facet — a test, a story, a server-rendered preview. */
export function EngineValueProvider({
  value,
  children,
}: {
  readonly value: EngineContextValue;
  readonly children: ReactNode;
}) {
  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>;
}

/**
 * Mounted once per open project, above the canvas and the inspector. Resolves the facet for
 * `project.engineId` and the UI plugin lazily beside it, under the project-level `<Suspense>`.
 */
export function EngineProvider({
  engineId,
  children,
}: {
  readonly engineId: EngineId;
  readonly children: ReactNode;
}) {
  const value = use(engineContextPromise(engineId));
  return <EngineValueProvider value={value}>{children}</EngineValueProvider>;
}

function useEngineContext(): EngineContextValue {
  const value = useContext(EngineContext);
  if (value === null) throw new Error('useEngine() must be called inside an <EngineProvider>');
  return value;
}

/**
 * The facet for the open project. THE IMPORTED FACET IS AUTHORITATIVE ON THE CLIENT: the
 * `GET /engines` payload carries capabilities and terminology too, but that exists for the
 * engine picker, which must render cards for engines whose facet is not bundled. Nothing else
 * reads capabilities from the wire.
 */
export function useEngine(): EngineStaticFacet {
  return useEngineContext().facet;
}

export function useEngineUi(): EngineUiPlugin {
  return useEngineContext().ui;
}
