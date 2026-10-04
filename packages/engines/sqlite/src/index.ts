import type { EngineDefinition } from '@schemaloom/engine-sdk';
import { AI_PROFILE } from './ai-profile.js';
import { annotateDiff } from './annotate.js';
import { EXPORTER } from './exporter.js';
import { IMPORTER } from './importer.js';
import { INTROSPECTOR } from './introspector.js';
import { MIGRATION_GENERATOR } from './migration.js';
import { QUERY_VALIDATOR } from './query-validator.js';
import { extractReferences } from './references.js';
import { sqliteFacet } from './static.js';
import { TEMPLATES } from './templates.js';
import { VALIDATOR } from './validator.js';
import { sameViewBody } from './view-body.js';

/**
 * `@schemaloom/engine-sqlite` — the full `EngineDefinition` (`docs/phase13/DESIGN.md`), loaded
 * by `apps/api` only. SQLite reads its own DDL (`node:sqlite`, in memory, allowlisted), reads a
 * live database from an uploaded file, and migrates with table rebuilds. Conformance holds each
 * `features` flag to its service.
 */
export const sqliteEngine: EngineDefinition = {
  ...sqliteFacet,
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

export { sqliteFacet } from './static.js';
export {
  CAPABILITIES,
  CODE,
  TERMINOLOGY,
  TYPE_CATALOG,
  affinityOf,
  normalizeName,
} from './static.js';
export { annotateDiff, typeChangeRisk } from './annotate.js';
export { EXPORTER } from './exporter.js';
export { MIGRATION_GENERATOR } from './migration.js';
export { QUERY_VALIDATOR } from './query-validator.js';
export { AI_PROFILE } from './ai-profile.js';
export { IMPORTER } from './importer.js';
export { INTROSPECTOR } from './introspector.js';
export { VALIDATOR, type SqliteValidator, type ValidationInput } from './validator.js';
export { extractReferences } from './references.js';
