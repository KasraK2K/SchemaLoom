/**
 * `@schemaloom/engine-sdk/conformance` — the §17 suite's surface. Its only consumer is an
 * engine package's own `*.spec.ts`.
 *
 * A SEPARATE ENTRY, not part of the "." barrel: this module imports vitest, and "." is loaded
 * by `apps/api` (CommonJS, where `require('vitest')` throws outright) and by the browser.
 */
export { runEngineConformance } from './run.js';
export { CONFORMANCE_CHECKS } from './types.js';
export type {
  ConformanceCheckId,
  ConformanceFixtures,
  ExpressionReferenceFixture,
  InvalidPropsFixture,
  MigrationFixture,
  QueryFixture,
  RoundTripFixture,
} from './types.js';
