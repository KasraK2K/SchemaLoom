import type { EngineDefinition } from '../definition.js';
import type { CheckRequirement, ConformanceCheck } from './check.js';
import { DECLARATION_CHECKS } from './checks-declaration.js';
import { DEFERRED_CHECKS } from './checks-deferred.js';
import { EXPORT_CHECKS } from './checks-export.js';
import { IMPORT_CHECKS } from './checks-import.js';
import { LINK_CHECKS } from './checks-links.js';
import { PROPS_CHECKS } from './checks-props.js';
import { QUERY_CHECKS } from './checks-query.js';
import { REFERENCE_CHECKS } from './checks-references.js';
import { TYPE_CHECKS } from './checks-types.js';
import { emitsQuickFixes, staleReferenceCandidate, VALIDATOR_CHECKS } from './checks-validator.js';
import { createCheckContext, type CheckContext } from './context.js';
import { CONFORMANCE_CHECKS, type ConformanceCheckId, type ConformanceFixtures } from './types.js';

const REGISTERED: readonly ConformanceCheck[] = [
  ...DECLARATION_CHECKS,
  ...TYPE_CHECKS,
  ...PROPS_CHECKS,
  ...LINK_CHECKS,
  ...REFERENCE_CHECKS,
  ...VALIDATOR_CHECKS,
  ...EXPORT_CHECKS,
  ...IMPORT_CHECKS,
  ...QUERY_CHECKS,
  ...DEFERRED_CHECKS,
];

/** null = satisfied. A string = the reason this check is skipped, printed in the run
 *  summary because §17 says a skip needs a written reason. */
function unmetReason(requires: CheckRequirement, ctx: CheckContext): string | null {
  const { engine } = ctx;
  switch (requires) {
    case 'validator':
      return engine.validator === undefined ? 'the engine ships no `validator` (§8)' : null;
    case 'importer':
      return engine.importer === undefined ? 'the engine ships no `importer` (§9)' : null;
    case 'exporter':
      return engine.exporter === undefined ? 'the engine ships no `exporter` (§10)' : null;
    case 'importer+exporter':
      return engine.importer === undefined || engine.exporter === undefined
        ? 'the engine ships no `importer` and/or `exporter` (§9, §10)'
        : null;
    case 'annotateDiff':
      return engine.annotateDiff === undefined ? 'the engine ships no `annotateDiff` (§11)' : null;
    case 'migrationGenerator':
      return engine.migrationGenerator === undefined
        ? 'the engine ships no `migrationGenerator` (§12); `features.migrations` is false'
        : null;
    case 'queryValidator':
      return engine.queryValidator === undefined
        ? 'the engine ships no `queryValidator` (§12); `features.queryValidation` is false'
        : null;
    case 'aiProfile':
      return engine.aiProfile === undefined ? 'the engine ships no `aiProfile` (§13)' : null;
    case 'quickFixes':
      if (engine.validator === undefined) return 'the engine ships no `validator` (§8)';
      return emitsQuickFixes(ctx)
        ? null
        : 'no diagnostic over the conformance fixtures carries a quick fix';
    case 'staleReferenceFixture':
      if (engine.validator === undefined) return 'the engine ships no `validator` (§8)';
      return staleReferenceCandidate(ctx.fixtures) === null
        ? 'no `expressionReferences` fixture names a field that is in `referenceModel`'
        : null;
    case 'esbuild':
      return ctx.fixtures.staticEntry === undefined
        ? 'no `staticEntry` fixture (§17: omit it to skip the bundle-size check)'
        : 'bundling needs `esbuild`, an optional peer dependency this workspace does not install';
  }
}

export interface ConformanceStep {
  readonly id: ConformanceCheckId;
  /** null = run it; a string = report it skipped, with this reason */
  readonly skip: string | null;
  readonly run: () => void | Promise<void>;
}

/**
 * One step per id in `CONFORMANCE_CHECKS`, in that order. The plan is built before any test
 * runs, so the reasons are known at collection time and vitest reports honest skips instead
 * of tests that pass by doing nothing.
 */
export function planConformance(
  engine: EngineDefinition,
  fixtures: ConformanceFixtures,
): readonly ConformanceStep[] {
  const ctx = createCheckContext(engine, fixtures);
  const byId = new Map(REGISTERED.map((c) => [c.id, c]));

  return CONFORMANCE_CHECKS.map((id): ConformanceStep => {
    const check = byId.get(id);
    if (check === undefined) {
      return {
        id,
        skip: null,
        run: () => {
          throw new Error(`conformance check "${id}" is in CONFORMANCE_CHECKS but not registered`);
        },
      };
    }

    const reason = check.requires === undefined ? null : unmetReason(check.requires, ctx);
    if (reason !== null) return { id, skip: reason, run: () => undefined };

    const run = check.run;
    if (run === undefined) {
      // The requirement is MET and the body is not written. This is the case §17 must never
      // let pass quietly: the service exists, so the check applies.
      return {
        id,
        skip: null,
        run: () => {
          throw new Error(
            `conformance check "${id}" has no body, but the engine now ships what it needs — write it`,
          );
        },
      };
    }
    // Returned, not discarded: an async body's rejection has to reach vitest.
    return { id, skip: null, run: () => run(ctx) };
  });
}
