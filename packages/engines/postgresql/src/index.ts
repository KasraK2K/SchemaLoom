import type { EngineDefinition } from '@schemaloom/engine-sdk';
import { EXPORTER } from './exporter.js';
import { IMPORTER } from './importer.js';
import { QUERY_VALIDATOR } from './query-validator.js';
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
 *  - `migrationGenerator` — Phase 4. Its absence must equal `features.migrations === false`,
 *    which `capabilities/services-match-features` checks. The same check holds the Phase-2
 *    `queryValidator` (present) to `features.queryValidation === true`.
 *  - `aiProfile` — Phase 2. No feature atom: its absence simply hides the AI panel.
 *  - `introspector` — cut entirely (doc 03 §3).
 */
export const postgresEngine: EngineDefinition = {
  ...postgresFacet,
  validator: VALIDATOR,
  importer: IMPORTER,
  exporter: EXPORTER,
  extractReferences,
  queryValidator: QUERY_VALIDATOR,
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
export { QUERY_VALIDATOR } from './query-validator.js';
export { IMPORTER, defaultImportOptions } from './importer.js';
/** The dynamic boundary, part of the package's public shape. `IMPORTER` and `QUERY_VALIDATOR` are its callers;
 *  a STATIC import of `libpg-query` anywhere in this graph would land a multi-megabyte WASM
 *  build in the browser bundle through `./static` (`static-boundary.spec.ts` guards it). */
export { loadSqlParser, type SqlParser } from './parser.js';
