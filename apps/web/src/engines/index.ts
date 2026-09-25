/**
 * The engine layer (doc 03 §16). Everything in the app imports from `@/engines`; only
 * `contract.ts` names the package the UI contract lives in, and only `register.ts` names an
 * engine.
 */
export { CapabilityGate } from './capability-gate';
export {
  EngineProvider,
  EngineValueProvider,
  useEngine,
  useEngineUi,
  type EngineContextValue,
} from './engine-provider';
export { loadEditorLanguage } from './editor-language';
export { FALLBACK_ENGINE_UI } from './fallback';
export { INSPECTOR_TABS, visibleTabs, type InspectorTab } from './inspector-tabs';
export { IndexesPanel } from './indexes-panel';
export {
  createEngineFacetRegistry,
  createEngineUiRegistry,
  engineFacets,
  engineUi,
} from './registry';
export { useTerminology, type Terminology } from './use-terminology';
export type * from './contract';
