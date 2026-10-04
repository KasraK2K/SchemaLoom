import type { EngineStaticFacet } from '@schemaloom/engine-sdk';
import { CAPABILITIES } from './capabilities.js';
import { DIAGNOSTIC_MESSAGES } from './messages.js';
import { normalizeName } from './normalize-name.js';
import { PROPS_SCHEMAS } from './props.js';
import { TERMINOLOGY } from './terminology.js';
import { TYPE_CATALOG } from './types.js';

/** The browser-safe half of the engine (doc 03 §1.1): data and pure functions, no parser. */
export const sqliteFacet: EngineStaticFacet = {
  id: 'sqlite',
  displayName: 'SQLite',
  /** semver of this plugin's BEHAVIOUR contract (§15), not of SQLite */
  version: '1.0.0',
  paradigm: 'relational',
  icon: 'database',
  summary: 'The embedded database in one file, for apps, tools and prototypes',
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
export { CODE } from './messages.js';
export { MAX_IDENTIFIER_LENGTH } from './normalize-name.js';
export { TYPE_DESCRIPTORS, affinityOf } from './types.js';
export type { ReferentialAction } from './props.js';
