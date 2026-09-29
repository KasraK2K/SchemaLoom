import type { EngineStaticFacet } from '@schemaloom/engine-sdk';
import { CAPABILITIES } from './capabilities.js';
import { DIAGNOSTIC_MESSAGES } from './messages.js';
import { normalizeName } from './normalize-name.js';
import { PROPS_SCHEMAS } from './props.js';
import { TERMINOLOGY } from './terminology.js';
import { TYPE_CATALOG } from './types.js';

/**
 * `@schemaloom/engine-postgresql/static` — the browser half (doc 03 §1.1).
 *
 * THE BOUNDARY THIS FILE IS: pure data plus pure functions over that data. No Node
 * built-in, no native module, and above all no `libpg-query` — the parser is a
 * multi-megabyte WASM build reached only through the dynamic `import()` in `parser.ts`,
 * which nothing in this graph touches. `static-boundary.spec.ts` walks the transitive
 * imports and fails if that ever stops being true; without it the canvas would just stop
 * loading one day and nobody would know which commit did it.
 *
 * `EngineDefinition extends EngineStaticFacet`, so the server spreads this object rather
 * than rebuilding it: one set of capabilities at runtime, not two that can disagree.
 */
export const postgresFacet: EngineStaticFacet = {
  id: 'postgresql',
  displayName: 'PostgreSQL',
  /** semver of this plugin's BEHAVIOUR contract (§15), not of the target server. */
  version: '1.0.0',
  paradigm: 'relational',
  icon: 'database',
  summary: 'The open-source relational database, with schemas, rich types and real constraints',
  capabilities: CAPABILITIES,
  typeCatalog: TYPE_CATALOG,
  terminology: TERMINOLOGY,
  diagnosticMessages: DIAGNOSTIC_MESSAGES,
  propsSchemas: PROPS_SCHEMAS,
  normalizeName,
};

export {
  CAPABILITIES,
  DIAGNOSTIC_MESSAGES,
  PROPS_SCHEMAS,
  TERMINOLOGY,
  TYPE_CATALOG,
  normalizeName,
};
export { NAMEDATALEN_BYTES, truncateToBytes, utf8ByteLength } from './normalize-name.js';
export { TYPE_DESCRIPTORS } from './types.js';
export { CODE } from './messages.js';
export type { ReferentialAction } from './props.js';
