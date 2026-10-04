import type { EngineDefinition } from '@schemaloom/engine-sdk';
import { AI_PROFILE } from './ai-profile.js';
import { annotateDiff } from './annotate.js';
import { EXPORTER } from './exporter.js';
import { IMPORTER } from './importer.js';
import { INTROSPECTOR } from './introspector.js';
import { MIGRATION_GENERATOR } from './migration.js';
import { QUERY_VALIDATOR } from './query-validator.js';
import { extractReferences } from './references.js';
import { mysqlFacet } from './static.js';
import { TEMPLATES } from './templates.js';
import { VALIDATOR } from './validator.js';
import { sameViewBody } from './view-body.js';

/**
 * `@schemaloom/engine-mysql` — the full `EngineDefinition` (design §4), loaded by `apps/api`
 * only: design, import and export (9a), the introspector (9b), the migration generator and
 * `annotateDiff` (9c), and the query validator and AI profile (9d). Conformance holds each
 * `features` flag to its service.
 */
export const mysqlEngine: EngineDefinition = {
  ...mysqlFacet,
  validator: VALIDATOR,
  importer: IMPORTER,
  exporter: EXPORTER,
  introspector: INTROSPECTOR,
  extractReferences,
  annotateDiff,
  sameViewBody,
  migrationGenerator: MIGRATION_GENERATOR,
  queryValidator: QUERY_VALIDATOR,
  aiProfile: AI_PROFILE,
  templates: TEMPLATES,
};

export { mysqlFacet } from './static.js';
export {
  CAPABILITIES,
  CODE,
  TERMINOLOGY,
  TYPE_CATALOG,
  isMariaDb,
  normalizeName,
} from './static.js';
export { annotateDiff, typeChangeRisk } from './annotate.js';
export { EXPORTER } from './exporter.js';
export { MIGRATION_GENERATOR } from './migration.js';
export { QUERY_VALIDATOR } from './query-validator.js';
export { AI_PROFILE } from './ai-profile.js';
export { IMPORTER } from './importer.js';
export {
  INTROSPECTOR,
  classifyMySqlError,
  formatServerVersion,
  mysqlConnectionOptions,
} from './introspector.js';
export { VALIDATOR, type MySqlValidator, type ValidationInput } from './validator.js';
export { extractReferences } from './references.js';
