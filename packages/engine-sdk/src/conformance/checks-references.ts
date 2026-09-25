import { expect } from 'vitest';
import { IR_OBJECT_TYPES, type Id, type IrObject } from '../ir.js';
import type { ConformanceCheck } from './check.js';

/**
 * §3.1 `extractReferences` — the engine's only obligation to the permission system. A miss
 * here is a leak, not a cosmetic failure: `VisibilityFilter` blanks an `engineProps` bag only
 * when it can see that an expression names a restricted object, so an id the engine forgets to
 * report is a CHECK body shipped to someone who may not read the column it names.
 */
export const REFERENCE_CHECKS: readonly ConformanceCheck[] = [
  {
    id: 'references/superset',
    run: ({ engine, fixtures }) => {
      const model = fixtures.referenceModel;
      expect(fixtures.expressionReferences.length).toBeGreaterThan(0);

      const missed: string[] = [];
      for (const fixture of fixtures.expressionReferences) {
        const got = engine.extractReferences(fixture.object, fixture.subKind, model);
        const seen = new Set(got.map((r) => `${r.type}:${r.id}`));
        for (const want of fixture.expectReferences) {
          // SUPERSET, not exact set: an extra id costs one viewer a dropped expression, a
          // missing one is the leak. So only the misses are failures.
          if (!seen.has(`${want.type}:${want.id}`)) {
            missed.push(`${fixture.object.id} does not report ${want.type}:${want.id}`);
          }
        }
      }
      expect(missed).toEqual([]);

      // Total and non-throwing over EVERY object in the model, not just the fixtures: it is
      // called on every write, and an engine that throws on an object shape it did not
      // anticipate takes the write down with it.
      for (const type of IR_OBJECT_TYPES) {
        const bag: Record<Id, IrObject> = model.objects[type];
        for (const object of Object.values(bag)) {
          expect(() => engine.extractReferences(object, null, model)).not.toThrow();
        }
      }
    },
  },
];
