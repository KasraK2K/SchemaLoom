import { describe, it } from 'vitest';
import type { EngineDefinition } from '../definition.js';
import { planConformance } from './plan.js';
import type { ConformanceFixtures } from './types.js';

/**
 * Doc 03 §17 — the suite every engine package passes before it is registered. One test file
 * per engine, and it is three lines:
 *
 * ```ts
 * import { runEngineConformance } from '@schemaloom/engine-sdk';
 * import { postgresEngine } from './index.js';
 * import { CONFORMANCE_FIXTURES } from './conformance-fixtures.js';
 *
 * runEngineConformance(postgresEngine, CONFORMANCE_FIXTURES);
 * ```
 *
 * POSITIONAL, two parameters (punch-list ∆9, confirmed by RECONCILIATION's open-items note,
 * which settled the name over `describeEngineConformance` and dropped the stray options bag).
 * If the suite ever genuinely needs options, §17 owns that decision.
 *
 * ONE `it` PER CHECK, not one per suite: a failure then names the check — `links/tolerates-
 * redacted` — and an engine author knows which contract they broke without reading a stack
 * trace. A skipped check is reported as a SKIP carrying its reason, never as a pass.
 */
export function runEngineConformance(
  engine: EngineDefinition,
  fixtures: ConformanceFixtures,
): void {
  const steps = planConformance(engine, fixtures);
  const skipped = steps.filter((s) => s.skip !== null).length;
  const title = `engine conformance: ${engine.id} — ${String(steps.length - skipped)} checks, ${String(skipped)} skipped`;

  describe(title, () => {
    for (const step of steps) {
      if (step.skip === null) it(step.id, step.run);
      else it.skip(`${step.id} — SKIPPED: ${step.skip}`, step.run);
    }
  });
}
