import type { EngineStaticFacet } from '@schemaloom/engine-sdk/ui';
import type { Extension } from '@codemirror/state';
import type { EngineUiPlugin } from './contract';

/**
 * The editor's language mode, resolved in the order §16.1/§16.4 lay out:
 *
 * 1. the UI plugin's own `loadEditorLanguage`, when it ships one;
 * 2. otherwise `capabilities.queryLanguage.codeMirrorMode`, which every engine declares;
 * 3. otherwise plain text.
 *
 * Step 2 is why the PostgreSQL plugin ships no `loadEditorLanguage`: CodeMirror lives in
 * `apps/web`, and forcing every engine UI package to depend on it just to satisfy a type
 * would be the heavier half of the contract for the smaller half of the value. `mode` is a
 * LANGUAGE id, not an engine id — 'sql' serves PostgreSQL, MySQL and SQLite alike.
 */
export async function loadEditorLanguage(
  facet: EngineStaticFacet,
  ui: EngineUiPlugin,
): Promise<Extension | null> {
  if (ui.loadEditorLanguage !== undefined) {
    // `Promise<unknown>` on the contract so an engine UI package need not depend on
    // CodeMirror; core is the one place that knows what the value is for.
    return (await ui.loadEditorLanguage()) as Extension;
  }
  if (facet.capabilities.queryLanguage.codeMirrorMode === 'sql') {
    const { sql } = await import('@codemirror/lang-sql');
    return sql();
  }
  return null;
}
