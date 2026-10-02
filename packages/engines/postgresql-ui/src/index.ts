import { postgresFacet } from '@schemaloom/engine-postgresql/static';
import type { LinkCheck, LinkKindDescriptor } from '@schemaloom/engine-sdk/ui';
import type { EngineUiPlugin, LinkStyle } from '@schemaloom/engine-sdk/ui';
import { PostgresEntityNode } from './entity-node.js';
import { ENGINE_ICONS } from './icons.js';
import {
  CONSTRAINT_SECTIONS,
  ENTITY_SECTIONS,
  FIELD_SECTIONS,
  INDEX_SECTIONS,
  LINK_SECTIONS,
} from './panels.js';
import { PostgresTypeBadge } from './type-badge.js';
import { PostgresTypePicker } from './type-picker.js';

/**
 * `@schemaloom/engine-postgresql-ui` — the PostgreSQL `EngineUiPlugin` (doc 03 §16).
 *
 * IT IMPORTS `@schemaloom/engine-postgresql/static` AND NEVER THE ROOT ENTRY. The root pulls
 * `libpg-query`, a multi-megabyte WASM parser, into whatever bundle touches it; the engine's
 * own `static-boundary.spec.ts` guards the facet's transitive graph and `import-boundary.spec.ts`
 * here guards this package's direct specifiers.
 *
 * Everything keyed by a kind id is DERIVED from the facet's descriptors rather than typed out,
 * so adding an entity kind or a link kind to `capabilities.ts` needs no edit in this file.
 */

/** Appearance only. The link RULES are declarative data the shared `checkLink` evaluates. */
const linkStyle = (kind: LinkKindDescriptor): LinkStyle => ({
  sourceMarker: kind.directed ? 'many' : 'none',
  targetMarker: kind.directed ? 'one' : 'none',
  // A documentation-only link is not a database constraint, and the canvas should say so.
  dashed: !kind.enforced,
});

/** Flavour text on a rejected drag. Core has already rendered the REASON through
 *  `formatMessage`; this is the engine's one chance to suggest a way forward. */
function connectionHint(check: LinkCheck): string | null {
  if (check.needsJunction) return 'PostgreSQL has no many-to-many key — add a junction table.';
  if (check.reasons.some((r) => r.code === 'link.typeMismatch'))
    return 'A foreign key needs matching column types on both ends.';
  return null;
}

export const postgresEngineUi: EngineUiPlugin = {
  engineId: postgresFacet.id,
  nodeRenderers: Object.fromEntries(
    postgresFacet.capabilities.entityKinds.map((kind) => [kind.id, PostgresEntityNode]),
  ),
  defaultNodeRenderer: PostgresEntityNode,
  panels: {
    entity: ENTITY_SECTIONS,
    field: FIELD_SECTIONS,
    link: LINK_SECTIONS,
    index: INDEX_SECTIONS,
    constraint: CONSTRAINT_SECTIONS,
    // No `customType` sections: an enum's ordered labels, a domain's check list and a
    // composite's attribute rows are list editors, not property rows, and the declarative
    // control set here cannot express one. Core's fallback props editor covers them until
    // a real list editor lands.
  },
  TypePicker: PostgresTypePicker,
  TypeBadge: PostgresTypeBadge,
  icons: ENGINE_ICONS,
  linkStyles: Object.fromEntries(
    postgresFacet.capabilities.linkKinds.map((kind) => [kind.id, linkStyle(kind)]),
  ),
  // No `loadEditorLanguage`: `@codemirror/lang-sql` is not a dependency of this package and
  // adding one would make every engine UI package depend on CodeMirror to satisfy a type.
  // `capabilities.queryLanguage.codeMirrorMode` is 'sql' and core loads the language from it.
  connectionHint,
};

export default postgresEngineUi;

export { PostgresEntityNode } from './entity-node.js';
export { PostgresTypeBadge } from './type-badge.js';
export { PostgresTypePicker } from './type-picker.js';
export type * from '@schemaloom/engine-sdk/ui';
