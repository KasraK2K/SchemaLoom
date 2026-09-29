import { expect } from 'vitest';
import { diffModels, isEmptyDiff, type SchemaModel } from '../ir.js';
import {
  DESTRUCTIVE_REMOVALS,
  PROPERTY_SEVERITY_RANK,
  compareMigrationSteps,
  entryIsDestructive,
  entryRiskKey,
  needsMigrationStep,
  type AnnotatedDiff,
  type MigrationPlan,
} from '../migration.js';
import type { ConformanceCheck } from './check.js';
import { cloneModel, type CheckContext } from './context.js';

/**
 * Doc 03 §11 — the four migration checks and the two annotation checks.
 *
 * The model pairs are the engine's own `migrations` fixtures, both directions, plus the
 * reference model against an EMPTY copy of itself — the pair that exercises every object
 * type the engine claims, as a create script one way and a drop script the other.
 */

function emptied(model: SchemaModel): SchemaModel {
  const objects = Object.fromEntries(Object.keys(model.objects).map((type) => [type, {}]));
  return { ...cloneModel(model), objects: objects as SchemaModel['objects'] };
}

interface Pair {
  readonly name: string;
  readonly before: SchemaModel;
  readonly after: SchemaModel;
}

function pairs(ctx: CheckContext): readonly Pair[] {
  const reference = ctx.fixtures.referenceModel;
  const out: Pair[] = [
    { name: 'reference -> empty', before: reference, after: emptied(reference) },
    { name: 'empty -> reference', before: emptied(reference), after: reference },
  ];
  for (const m of ctx.fixtures.migrations) {
    out.push({ name: m.name, before: m.before, after: m.after });
    out.push({ name: `${m.name} (reversed)`, before: m.after, after: m.before });
  }
  return out;
}

function annotate(ctx: CheckContext, pair: Pair): AnnotatedDiff {
  const { annotateDiff } = ctx.engine;
  if (annotateDiff === undefined) {
    throw new Error('the engine ships a `migrationGenerator` but no `annotateDiff` — §11.1 requires both');
  }
  const diff = diffModels(pair.before, pair.after, {
    ignoreCosmetic: true,
    normalizeName: (s) => ctx.engine.normalizeName(s),
  });
  return annotateDiff(diff, pair.before, pair.after);
}

async function plan(
  ctx: CheckContext,
  pair: Pair,
  allowDestructive = false,
): Promise<{ diff: AnnotatedDiff; plan: MigrationPlan }> {
  const generator = ctx.engine.migrationGenerator;
  if (generator === undefined) throw new Error('unreachable: the check requires `migrationGenerator`');
  const diff = annotate(ctx, pair);
  return {
    diff,
    plan: await generator.generate({
      diff,
      before: pair.before,
      after: pair.after,
      options: { allowDestructive, transactional: true, engineOptions: {} },
      context: ctx.engineContext,
    }),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const MIGRATION_CHECKS: readonly ConformanceCheck[] = [
  {
    id: 'migration/empty-diff-no-steps',
    requires: 'migrationGenerator',
    run: async (ctx) => {
      // Guarantee 1. Every model diffed against ITSELF.
      const models = [ctx.fixtures.referenceModel, ...ctx.fixtures.migrations.flatMap((m) => [m.before, m.after])];
      for (const model of models) {
        const pair = { name: 'self', before: model, after: cloneModel(model) };
        const { diff, plan: result } = await plan(ctx, pair);
        expect(isEmptyDiff(diff, { ignoreCosmetic: true })).toBe(true);
        expect(result.steps).toEqual([]);
        expect(result.unsupported).toEqual([]);
      }
    },
  },
  {
    id: 'migration/drops-are-destructive',
    requires: 'migrationGenerator',
    run: async (ctx) => {
      for (const pair of pairs(ctx)) {
        for (const allow of [false, true]) {
          const { diff, plan: result } = await plan(ctx, pair, allow);
          const covering = (key: string) =>
            result.steps.filter((s) => s.covers.some((ref) => entryRiskKey({ objectType: ref.type, id: ref.id }) === key));

          for (const entry of diff.entries) {
            if (entry.change !== 'removed' || !DESTRUCTIVE_REMOVALS.has(entry.objectType)) continue;
            // Core's pre-set survives the annotation boundary (doc 04 §7.7)...
            expect(entryIsDestructive(diff, entry), `${pair.name}: ${entryRiskKey(entry)}`).toBe(true);
            // ...and reaches the script: a step that drops it is red.
            const steps = covering(entryRiskKey(entry));
            if (steps.length > 0) {
              expect(steps.some((s) => s.destructive), `${pair.name}: ${entryRiskKey(entry)}`).toBe(true);
            }
          }
          for (const step of result.steps) {
            expect(step.commentedOut, `${pair.name}: step ${String(step.ordinal)}`).toBe(step.destructive && !allow);
            if (step.destructive || step.lossy || step.requiresTableRewrite) {
              expect(step.reasonCode, `${pair.name}: step ${String(step.ordinal)} needs a reasonCode`).not.toBeNull();
            }
          }
        }
      }
      // The engine's own expectations about its fixtures.
      for (const m of ctx.fixtures.migrations) {
        const { plan: result } = await plan(ctx, { name: m.name, before: m.before, after: m.after });
        expect(result.steps.some((s) => s.destructive), `${m.name}: destructive`).toBe(m.expectDestructive);
        expect(result.steps.some((s) => s.lossy), `${m.name}: lossy`).toBe(m.expectLossy);
      }
    },
  },
  {
    id: 'migration/accounts-for-every-change',
    requires: 'migrationGenerator',
    run: async (ctx) => {
      // Guarantee 2: covered by at least one step or listed as unsupported, never both, and
      // a step covers only entries that exist.
      for (const pair of pairs(ctx)) {
        const { diff, plan: result } = await plan(ctx, pair);
        const inDiff = new Set(diff.entries.map(entryRiskKey));
        const covered = new Set<string>();
        for (const step of result.steps) {
          expect(step.covers.length, `${pair.name}: step ${String(step.ordinal)} covers nothing`).toBeGreaterThan(0);
          for (const ref of step.covers) {
            const key = entryRiskKey({ objectType: ref.type, id: ref.id });
            expect(inDiff.has(key), `${pair.name}: step covers ${key}, not in the diff`).toBe(true);
            covered.add(key);
          }
        }
        const unsupported = new Set(result.unsupported.map((u) => entryRiskKey({ objectType: u.entry.type, id: u.entry.id })));
        for (const entry of diff.entries.filter(needsMigrationStep)) {
          const key = entryRiskKey(entry);
          expect(covered.has(key) || unsupported.has(key), `${pair.name}: ${key} is unaccounted for`).toBe(true);
          expect(covered.has(key) && unsupported.has(key), `${pair.name}: ${key} is both`).toBe(false);
        }
      }
    },
  },
  {
    id: 'migration/steps-ordered',
    requires: 'migrationGenerator',
    run: async (ctx) => {
      for (const pair of pairs(ctx)) {
        const { plan: result } = await plan(ctx, pair);
        expect(result.steps.map((s) => s.ordinal)).toEqual(result.steps.map((_, i) => i));
        // `Array.prototype.sort` is stable, so re-sorting is a no-op exactly when the steps
        // are already in guarantee 3's (phase, operation) order.
        expect([...result.steps].sort(compareMigrationSteps)).toEqual(result.steps);
      }
    },
  },
  {
    id: 'diff/annotate-is-pure',
    requires: 'annotateDiff',
    run: (ctx) => {
      const annotateDiff = ctx.engine.annotateDiff;
      if (annotateDiff === undefined) throw new Error('unreachable: the check requires `annotateDiff`');
      for (const pair of pairs(ctx)) {
        const diff = diffModels(pair.before, pair.after, { normalizeName: (s) => ctx.engine.normalizeName(s) });
        const snapshot = JSON.parse(JSON.stringify(diff)) as unknown;
        // Frozen, so a write into the input throws in strict mode rather than passing.
        const once = annotateDiff(deepFreeze(diff), pair.before, pair.after);
        expect(diff).toEqual(snapshot);
        expect(annotateDiff(once, pair.before, pair.after)).toEqual(once);
        expect(once.annotatedBy).toBe(ctx.engine.id);
      }
    },
  },
  {
    id: 'diff/annotate-never-raises-severity',
    requires: 'annotateDiff',
    run: (ctx) => {
      const annotateDiff = ctx.engine.annotateDiff;
      if (annotateDiff === undefined) throw new Error('unreachable: the check requires `annotateDiff`');
      for (const pair of pairs(ctx)) {
        const diff = diffModels(pair.before, pair.after, { normalizeName: (s) => ctx.engine.normalizeName(s) });
        const annotated = annotateDiff(diff, pair.before, pair.after);
        const byKey = new Map(annotated.entries.map((e) => [entryRiskKey(e), e]));
        for (const entry of diff.entries) {
          const out = byKey.get(entryRiskKey(entry));
          expect(out, `${pair.name}: ${entryRiskKey(entry)} was dropped`).toBeDefined();
          if (entry.change !== 'changed' || out?.change !== 'changed') continue;
          const after = new Map(out.properties.map((p) => [p.path.join('\u0000'), p.severity]));
          for (const p of entry.properties) {
            const severity = after.get(p.path.join('\u0000'));
            expect(severity, `${pair.name}: ${entryRiskKey(entry)} lost ${p.path.join('.')}`).toBeDefined();
            if (severity === undefined) continue;
            expect(PROPERTY_SEVERITY_RANK[severity]).toBeLessThanOrEqual(PROPERTY_SEVERITY_RANK[p.severity]);
            // Neither assign nor remove `governance`: core's call alone (doc 04 §7.4).
            expect(severity === 'governance').toBe(p.severity === 'governance');
          }
        }
      }
    },
  },
];
