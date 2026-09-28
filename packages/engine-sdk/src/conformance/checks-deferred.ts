import type { ConformanceCheck } from './check.js';

/**
 * The checks whose SUBJECT does not exist yet.
 *
 * Every entry here declares what it needs and ships no body. While the service is absent the
 * check is reported as a SKIP with that reason. The moment an engine ships the service, the
 * requirement is met, the body is still missing, and `plan.ts` registers a FAILING test that
 * names the check. So `roundtrip/ddl-ir-ddl` turns itself on the day step 20's exporter and
 * step 21's importer land, and cannot be forgotten.
 *
 * The alternative — a body that quietly passes when there is nothing to export — is how a
 * broken exporter ships with a green suite behind it.
 */
export const DEFERRED_CHECKS: readonly ConformanceCheck[] = [
  // §9 Importer (step 21), §10 Exporter (step 20), the two round-trip checks and the two
  // props checks that need an importer's output now have bodies: `checks-import.ts` and
  // `checks-export.ts`. `props/accept-exporter-roundtrip` and `roundtrip/idempotent` moved
  // from `requires: 'exporter'` to `'importer+exporter'` when they were written — both names
  // describe a ROUND TRIP, and neither can be tested without reading the DDL back, so the
  // narrower requirement would have skipped them on an export-only engine while claiming to
  // cover them.

  // §12 MigrationGenerator — Phase 4.
  { id: 'migration/empty-diff-no-steps', requires: 'migrationGenerator' },
  { id: 'migration/drops-are-destructive', requires: 'migrationGenerator' },
  { id: 'migration/accounts-for-every-change', requires: 'migrationGenerator' },
  { id: 'migration/steps-ordered', requires: 'migrationGenerator' },

  // §11 annotateDiff — build-order step 11, which also needs schema-model's `SchemaDiff`.
  { id: 'diff/annotate-is-pure', requires: 'annotateDiff' },
  { id: 'diff/annotate-never-raises-severity', requires: 'annotateDiff' },

  // §13 AiProfile — Phase 2. No feature atom: absence just hides the AI panel.
  { id: 'ai/serialize-deterministic', requires: 'aiProfile' },
  { id: 'ai/serialize-respects-budget', requires: 'aiProfile' },
  { id: 'ai/serialize-omits-restricted', requires: 'aiProfile' },
  { id: 'ai/serialize-escapes-docs', requires: 'aiProfile' },
  { id: 'ai/parse-output-tolerant', requires: 'aiProfile' },

  // §17's own optional check: bundling `staticEntry` with esbuild and asserting min+gzip is
  // under budget. `esbuild` is an optional peer dependency (§1) that this workspace does not
  // install, and a dynamic `import('esbuild')` in this module would put an esbuild-shaped
  // hole in the browser bundle of every consumer of the SDK's "." entry.
  { id: 'static/bundle-size', requires: 'esbuild' },
];
