import type { EngineDefinition } from '@schemaloom/engine-sdk';
import { annotateDiff } from './annotate.js';
import { AI_PROFILE } from './ai-profile.js';
import { EXPORTER } from './exporter.js';
import { IMPORTER } from './importer.js';
import { INTROSPECTOR } from './introspector.js';
import { MIGRATION_GENERATOR } from './migration.js';
import { QUERY_VALIDATOR } from './query-validator.js';
import { extractReferences } from './references.js';
import { postgresFacet } from './static.js';
import { VALIDATOR } from './validator.js';
import { TEMPLATES } from './templates.js';

/**
 * `@schemaloom/engine-postgresql` — the full `EngineDefinition`, loaded by `apps/api`
 * only. One line in `apps/api/src/engines/engines.manifest.ts` installs it; nothing else
 * in core ever names an engine (C10).
 *
 * The facet is SPREAD, not rebuilt: there is one capabilities object, one type catalog
 * and one terminology bundle at runtime, shared with `./static`.
 *
 * `migrationGenerator` and `aiProfile` (Phase 5) and `queryValidator` (Phase 2) are present, and
 * `capabilities/services-match-features` holds them to `features.migrations` and
 * `features.queryValidation` both being true.
 *
 * `introspector` (Phase 6 §2) runs `pg_dump`; `capabilities.connectionFields` is its form.
 */
export const postgresEngine: EngineDefinition = {
  ...postgresFacet,
  validator: VALIDATOR,
  importer: IMPORTER,
  introspector: INTROSPECTOR,
  exporter: EXPORTER,
  extractReferences,
  queryValidator: QUERY_VALIDATOR,
  annotateDiff,
  migrationGenerator: MIGRATION_GENERATOR,
  aiProfile: AI_PROFILE,
  templates: TEMPLATES,
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
export { annotateDiff, typeChangeRisk } from './annotate.js';
export { MIGRATION_GENERATOR } from './migration.js';
export { AI_PROFILE } from './ai-profile.js';
export { IMPORTER, defaultImportOptions } from './importer.js';
export {
  INTROSPECTOR,
  classifyPgDumpError,
  dumpedServerVersion,
  pgDumpInvocation,
} from './introspector.js';
/** The dynamic boundary, part of the package's public shape. `IMPORTER` and `QUERY_VALIDATOR` are its callers;
 *  a STATIC import of `libpg-query` anywhere in this graph would land a multi-megabyte WASM
 *  build in the browser bundle through `./static` (`static-boundary.spec.ts` guards it). */
export { loadSqlParser, type SqlParser } from './parser.js';
