import { Database, Eye, KeyRound, Layers, Table2 } from 'lucide-react';
import type { EngineIcon } from './contract.js';

/**
 * The icon NAMES are the facet's (`EngineStaticFacet.icon`, `EntityKindDescriptor.icon`), so
 * they are declared once, in `capabilities.ts`. This map only turns a name into a component —
 * the half that cannot live on a JSON facet.
 *
 * `lucide-react` is a dependency of this package, not of apps/web; that is why this indirection
 * exists at all rather than core importing the icon itself.
 */
export const ENGINE_ICONS: Readonly<Record<string, EngineIcon>> = {
  database: Database,
  table: Table2,
  eye: Eye,
  layers: Layers,
  key: KeyRound,
};

/** Total: an unmapped name degrades to the engine's own icon rather than rendering nothing. */
export function resolveIcon(name: string): EngineIcon {
  return ENGINE_ICONS[name] ?? Database;
}
