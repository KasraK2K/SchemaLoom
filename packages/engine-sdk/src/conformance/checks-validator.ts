import { expect } from 'vitest';
import { sortDiagnostics, type Diagnostic } from '../diagnostics.js';
import type { Id, SchemaModel } from '../ir.js';
import type { ConformanceCheck } from './check.js';
import {
  brokenCopy,
  clearRefs,
  cloneModel,
  seatRefs,
  type CheckContext,
  type ConformanceValidator,
} from './context.js';
import type { ConformanceFixtures, ExpressionReferenceFixture } from './types.js';

/** §8 `EngineValidator` — synchronous, pure, sorted, and clean on a model the engine itself
 *  says is legal. */

function validatorOf(ctx: CheckContext): ConformanceValidator {
  // `plan.ts` skips every validator check when there is none, so reaching here without one is
  // a bug in the plan rather than a condition to tolerate.
  if (ctx.validator === null) throw new Error('conformance: no validator on this engine');
  return ctx.validator;
}

function diagnose(ctx: CheckContext, model: SchemaModel): readonly Diagnostic[] {
  return validatorOf(ctx).validate({ model, context: ctx.engineContext });
}

/**
 * The first expression fixture whose expected references include a field that is really in
 * the reference model. `validator/expression-reference-stale` needs one to make stale, and
 * `plan.ts` calls this to decide whether the check can run at all.
 */
export function staleReferenceCandidate(
  fixtures: ConformanceFixtures,
): { readonly fixture: ExpressionReferenceFixture; readonly fieldId: Id } | null {
  const model = fixtures.referenceModel;
  for (const fixture of fixtures.expressionReferences) {
    for (const ref of fixture.expectReferences) {
      if (ref.type !== 'field') continue;
      if (model.objects.field[ref.id] === undefined) continue;
      return { fixture, fieldId: ref.id };
    }
  }
  return null;
}

/** Whether ANY diagnostic over the conformance fixtures carries a quick fix. An engine that
 *  emits none cannot be asked to prove its quick fixes resolve. */
export function emitsQuickFixes(ctx: CheckContext): boolean {
  if (ctx.validator === null) return false;
  try {
    const models = [ctx.fixtures.referenceModel, brokenCopy(ctx.engine, ctx.fixtures.referenceModel)];
    return models.some((m) => diagnose(ctx, m).some((d) => d.quickFix !== undefined));
  } catch {
    // This runs at COLLECTION time. A validator that throws is a real failure, but it belongs
    // to `validator/deterministic`, which reports it as one test rather than taking the whole
    // file down before a single check has registered.
    return false;
  }
}

export const VALIDATOR_CHECKS: readonly ConformanceCheck[] = [
  {
    id: 'validator/deterministic',
    requires: 'validator',
    run: (ctx) => {
      const broken = brokenCopy(ctx.engine, ctx.fixtures.referenceModel);
      for (const model of [ctx.fixtures.referenceModel, broken]) {
        // Pure: no clock, no randomness, and no mutation of the input — a validator that
        // edits the model it was handed corrupts the very object the mutation response is
        // about to broadcast.
        const before = JSON.stringify(model);
        const runs = [diagnose(ctx, model), diagnose(ctx, model), diagnose(ctx, model)];
        expect(runs[1]).toEqual(runs[0]);
        expect(runs[2]).toEqual(runs[0]);
        expect(JSON.stringify(model)).toBe(before);
      }
      // ...over a model that actually produces diagnostics. Three identical empty arrays
      // prove nothing.
      if (Object.keys(broken.objects.entity).length > 0) {
        expect(diagnose(ctx, broken).length).toBeGreaterThan(0);
      }
    },
  },
  {
    id: 'validator/sorted',
    requires: 'validator',
    run: (ctx) => {
      // §2.5's ordering contract is what makes a cached diagnostic payload diff-stable.
      for (const model of [ctx.fixtures.referenceModel, brokenCopy(ctx.engine, ctx.fixtures.referenceModel)]) {
        const result = diagnose(ctx, model);
        expect(sortDiagnostics(result)).toEqual(result);
      }
    },
  },
  {
    id: 'validator/clean-on-reference-ir',
    requires: 'validator',
    run: (ctx) => {
      // The reference model is the engine's own statement of what it supports. An error on
      // it means the engine contradicts itself.
      const errors = diagnose(ctx, ctx.fixtures.referenceModel).filter(
        (d) => d.severity === 'error',
      );
      expect(errors.map((d) => `${d.code} on ${d.target.type}:${d.target.id}`)).toEqual([]);
    },
  },
  {
    id: 'validator/quickfix-resolves',
    requires: 'quickFixes',
  },
  {
    id: 'validator/expression-reference-stale',
    requires: 'staleReferenceFixture',
    run: (ctx) => {
      const candidate = staleReferenceCandidate(ctx.fixtures);
      if (candidate === null) throw new Error('conformance: no stale-reference candidate');
      const { fixture, fieldId } = candidate;
      const model = ctx.fixtures.referenceModel;

      // What core persists: the engine's OWN output, not a hand-written ref set.
      const refs = ctx.engine.extractReferences(fixture.object, fixture.subKind, model);
      const persisted = {
        entityIds: refs.filter((r) => r.type === 'entity').map((r) => r.id),
        fieldIds: refs.filter((r) => r.type === 'field').map((r) => r.id),
      };

      // Then the column the expression names goes away. Nothing rewrote the expression, so
      // the persisted reference is now pointing at something that is not there — the exact
      // dangling-reference case §8.2 says only the engine can see.
      const withoutField = (): SchemaModel => {
        const clone = cloneModel(model);
        clone.objects.field = Object.fromEntries(
          Object.entries(clone.objects.field).filter(([id]) => id !== fieldId),
        );
        return clone;
      };

      const stale = withoutField();
      expect(seatRefs(stale, fixture.object.id, persisted)).toBe(true);

      const control = withoutField();
      clearRefs(control, fixture.object.id);

      const onObject = (d: Diagnostic): boolean => d.target.id === fixture.object.id;
      const withRefs = diagnose(ctx, stale).filter(onObject);
      const withoutRefs = diagnose(ctx, control).filter(onObject);

      // The control is what isolates the signal: deleting a column breaks other things too,
      // and only the diagnostics that DISAPPEAR when the persisted refs are removed were
      // caused by the stale reference.
      expect(withRefs.length).toBeGreaterThan(withoutRefs.length);
    },
  },
];
