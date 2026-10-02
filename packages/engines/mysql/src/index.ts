import type { EngineDefinition } from '@schemaloom/engine-sdk';
import { AI_PROFILE } from './ai-profile.js';
import { annotateDiff } from './annotate.js';
import { EXPORTER } from './exporter.js';
import { IMPORTER } from './importer.js';
import { MIGRATION_GENERATOR } from './migration.js';
import { QUERY_VALIDATOR } from './query-validator.js';
import { extractReferences } from './references.js';
import { mysqlFacet } from './static.js';
import { TEMPLATES } from './templates.js';
import { VALIDATOR } from './validator.js';

/**
 * `@schemaloom/engine-mysql` — the full `EngineDefinition` (design §4), loaded by `apps/api`
 * only. Step 9a: design, import and export. The introspector (9b), the migration generator
 * and `annotateDiff` (9c), and the query validator and AI profile (9d) are added as they are
 * built; conformance holds each `features` flag to its service.
 */
export const mysqlEngine: EngineDefinition = {
  ...mysqlFacet,
  validator: VALIDATOR,
  importer: IMPORTER,
  exporter: EXPORTER,
  extractReferences,
  annotateDiff,
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
export { VALIDATOR, type MySqlValidator, type ValidationInput } from './validator.js';
export { extractReferences } from './references.js';
