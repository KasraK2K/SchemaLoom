import type { CheckContext } from './context.js';
import type { ConformanceCheckId } from './types.js';

/**
 * Something a check needs that the engine may not ship yet. A check whose requirement is
 * unmet is reported as a SKIP with the reason, never as a pass: a silent pass on
 * `export/deterministic` is how a broken exporter ships.
 *
 * The other half of that deal is in `plan.ts`: a check whose requirement is MET but whose
 * `run` is still absent registers a FAILING test. So the day step 20 adds an `exporter`, the
 * export checks stop skipping and start demanding a body.
 */
export type CheckRequirement =
  | 'validator'
  | 'importer'
  | 'exporter'
  | 'importer+exporter'
  | 'annotateDiff'
  | 'migrationGenerator'
  | 'queryValidator'
  | 'aiProfile'
  | 'quickFixes'
  | 'staleReferenceFixture'
  | 'esbuild';

export interface ConformanceCheck {
  readonly id: ConformanceCheckId;
  /** absent = the check needs nothing beyond what every engine must ship */
  readonly requires?: CheckRequirement;
  /** absent = the body lands with the service the check requires.
   *
   *  `Promise<void>` is admitted because §9's `Importer.import` and §10's `Exporter.export`
   *  both return one; vitest awaits whatever a test returns, so an async body is a normal
   *  test and not a special case. */
  readonly run?: (ctx: CheckContext) => void | Promise<void>;
}
