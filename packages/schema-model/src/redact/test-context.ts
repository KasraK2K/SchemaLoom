import type { VisibilityContext } from './context.js';

/** Test-only. Deliberately not re-exported from `index.ts`, so nothing ships. */
export function ctx(over: Partial<VisibilityContext> = {}): VisibilityContext {
  return {
    projectId: 'prj_1',
    subjectKind: 'user',
    subjectKey: 'u:1',
    canOpenProject: true,
    visibleEntityIds: new Set<string>(),
    restrictedOkEntityIds: new Set<string>(),
    areasWithAtoms: new Set<string>(),
    restrictedFieldMode: 'mask',
    totalEntityCount: 0,
    entitiesWithRestrictedFields: new Set<string>(),
    ...over,
  };
}
