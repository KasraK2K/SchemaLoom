import { mysqlFacet } from '@schemaloom/engine-mysql/static';
import type { LinkCheck, LinkKindDescriptor } from '@schemaloom/engine-sdk/ui';
import type { EngineUiPlugin, LinkStyle } from '@schemaloom/engine-sdk/ui';
import { MySqlEntityNode } from './entity-node.js';
import { ENGINE_ICONS } from './icons.js';
import {
  CONSTRAINT_SECTIONS,
  ENTITY_SECTIONS,
  FIELD_SECTIONS,
  INDEX_SECTIONS,
  LINK_SECTIONS,
} from './panels.js';
import { MySqlTypeBadge } from './type-badge.js';
import { MySqlTypePicker } from './type-picker.js';

/**
 * `@schemaloom/engine-mysql-ui` — the MySQL `EngineUiPlugin` (doc 03 §16).
 *
 * IT IMPORTS `@schemaloom/engine-mysql/static` AND NEVER THE ROOT ENTRY. The root pulls
 * `node-sql-parser`, a large SQL grammar, into whatever bundle touches it; the engine's
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
  if (check.needsJunction) return 'MySQL has no many-to-many key — add a junction table.';
  if (check.reasons.some((r) => r.code === 'link.typeMismatch'))
    return 'MySQL needs both ends of a foreign key to have the same type and signedness.';
  return null;
}

export const mysqlEngineUi: EngineUiPlugin = {
  engineId: mysqlFacet.id,
  nodeRenderers: Object.fromEntries(
    mysqlFacet.capabilities.entityKinds.map((kind) => [kind.id, MySqlEntityNode]),
  ),
  defaultNodeRenderer: MySqlEntityNode,
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
  TypePicker: MySqlTypePicker,
  TypeBadge: MySqlTypeBadge,
  icons: ENGINE_ICONS,
  linkStyles: Object.fromEntries(
    mysqlFacet.capabilities.linkKinds.map((kind) => [kind.id, linkStyle(kind)]),
  ),
  // No `loadEditorLanguage`: `@codemirror/lang-sql` is not a dependency of this package and
  // adding one would make every engine UI package depend on CodeMirror to satisfy a type.
  // `capabilities.queryLanguage.codeMirrorMode` is 'sql' and core loads the language from it.
  connectionHint,
};

export default mysqlEngineUi;

export { MySqlEntityNode } from './entity-node.js';
export { MySqlTypeBadge } from './type-badge.js';
export { MySqlTypePicker } from './type-picker.js';
export type * from '@schemaloom/engine-sdk/ui';
