import type { EngineDefinition } from '@schemaloom/engine-sdk';
import { EXPORTER } from './exporter.js';
import { IMPORTER } from './importer.js';
import { extractReferences } from './references.js';
import { postgresFacet } from './static.js';
import { VALIDATOR } from './validator.js';

/**
 * `@schemaloom/engine-postgresql` — the full `EngineDefinition`, loaded by `apps/api`
 * only. One line in `apps/api/src/engines/engines.manifest.ts` installs it; nothing else
 * in core ever names an engine (C10).
 *
 * The facet is SPREAD, not rebuilt: there is one capabilities object, one type catalog
 * and one terminology bundle at runtime, shared with `./static`.
 *
 * ABSENT ON PURPOSE, and each absence is a declaration rather than a gap:
 *  - `annotateDiff` — step 11, which needs schema-model's `SchemaDiff` (step 18).
 *  - `migrationGenerator` / `queryValidator` — Phase 4 and Phase 2. Their absence must
 *    equal `features.migrations === false` and `features.queryValidation === false`,
 *    which `capabilities/services-match-features` checks; both are declared false.
 *  - `aiProfile` — Phase 2. No feature atom: its absence simply hides the AI panel.
 *  - `introspector` — cut entirely (doc 03 §3).
 */
export const postgresEngine: EngineDefinition = {
  ...postgresFacet,
  validator: VALIDATOR,
  importer: IMPORTER,
  exporter: EXPORTER,
  extractReferences,
};

export { postgresFacet } from './static.js';
export {
  CAPABILITIES,
  CODE,
  DIAGNOSTIC_MESSAGES,
  PROPS_SCHEMAS,
  TERMINOLOGY,
  TYPE_CATALOG,
  TYPE_DESCRIPTORS,
  normalizeName,
  type ReferentialAction,
} from './static.js';
export { extractReferences, expressionsOf } from './references.js';
export { VALIDATOR, type PostgresValidator, type ValidationInput } from './validator.js';
export { EXPORTER } from './exporter.js';
export { IMPORTER, defaultImportOptions } from './importer.js';
/** The dynamic boundary, part of the package's public shape. `IMPORTER` is its only caller;
 *  a STATIC import of `libpg-query` anywhere in this graph would land a multi-megabyte WASM
 *  build in the browser bundle through `./static` (`static-boundary.spec.ts` guards it). */
export { loadSqlParser, type SqlParser } from './parser.js';
