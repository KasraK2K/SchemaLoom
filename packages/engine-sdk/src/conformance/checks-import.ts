import { expect } from 'vitest';
import { parseEngineProps } from '../props.js';
import type { EnginePropsKind } from '../diagnostics.js';
import type { ImportReport, ImportResult } from '../importer.js';
import { IMPORT_STATEMENT_STATUSES } from '../importer.js';
import type { Id, IrObjectType, SchemaModel } from '../ir.js';
import type { CheckContext } from './context.js';
import type { ConformanceCheck } from './check.js';
import {
  allObjects,
  objectCounts,
  renderExport,
  runExport,
  runImport,
  structuralDigest,
} from './io-context.js';
import type { RoundTripFixture } from './types.js';

/**
 * Doc 03 §9 — the importer's four checks, plus the two round-trip checks that need both
 * services, plus the two props checks whose input only exists once an importer does.
 *
 * THE ONE THING THEY ALL TEST, from four angles: an importer accounts for every statement in
 * the source. A dropped statement is the failure mode that survives every other kind of
 * testing, because the model that comes out still looks reasonable.
 */

/** Sources no engine can make sense of. `import/never-throws` runs the importer at each of
 *  them and demands a REPORT rather than an exception. */
const HOSTILE_SOURCES: readonly string[] = [
  '',
  '   \n\t  ',
  ';;;;',
  'this is not sql at all',
  'CREATE TABLE (',
  "SELECT 'unterminated",
  '/* unterminated comment',
  '\u0000\u0001\u0002',
];

function requireFixtures(ctx: CheckContext): readonly RoundTripFixture[] {
  // An engine that ships an importer and no round-trip fixture has declared a capability it
  // never demonstrates. §17 asserts non-empty for exactly that reason.
  expect(ctx.fixtures.roundTrip.length).toBeGreaterThan(0);
  return ctx.fixtures.roundTrip;
}

/** Every props bag in a model, with the kind and sub-kind its schema is resolved by. */
function propsBags(
  model: SchemaModel,
): readonly { kind: EnginePropsKind; subKind: string | null; value: unknown; id: Id }[] {
  const out: { kind: EnginePropsKind; subKind: string | null; value: unknown; id: Id }[] = [];

  for (const { type, object } of allObjects(model)) {
    if (type === 'area') continue; // the one IR object with no `engineProps` (doc 04 §2.11)
    out.push({
      kind: type,
      subKind: 'kind' in object ? object.kind : null,
      value: object.engineProps,
      id: object.id,
    });
  }
  for (const index of Object.values(model.objects.index)) {
    for (const column of index.columns) {
      out.push({ kind: 'indexColumn', subKind: null, value: column.engineProps, id: index.id });
    }
  }
  return out;
}

function assertPropsAccepted(ctx: CheckContext, model: SchemaModel, origin: string): void {
  const rejected = propsBags(model)
    .map((bag) => ({
      bag,
      result: parseEngineProps(ctx.engine, bag.kind, bag.subKind, bag.value),
    }))
    .filter((entry) => !entry.result.ok)
    .map((entry) => `${origin}: ${entry.bag.kind}/${entry.bag.subKind ?? '(none)'} ${entry.bag.id}`);
  expect(rejected).toEqual([]);
}

/** §9's invariants 1, 2 and 5, checked over one report. */
function assertReportShape(report: ImportReport, model: SchemaModel): readonly string[] {
  const problems: string[] = [];

  if (report.statements.length !== report.statementCount) {
    problems.push('statementCount does not match statements.length');
  }

  let previousEnd = -1;
  for (const [index, statement] of report.statements.entries()) {
    if (statement.ordinal !== index) problems.push(`ordinal ${String(statement.ordinal)} is not ${String(index)}`);
    if (statement.range.start < previousEnd) {
      problems.push(`statement ${String(index)} overlaps the one before it`);
    }
    if (statement.range.end < statement.range.start) {
      problems.push(`statement ${String(index)} has a backwards range`);
    }
    if (statement.range.line < 1 || statement.range.column < 1) {
      problems.push(`statement ${String(index)} has a 0-based line or column`);
    }
    if (statement.excerpt.length > 200) {
      problems.push(`statement ${String(index)} has an excerpt over 200 characters`);
    }
    previousEnd = statement.range.end;

    // Invariant 5: every produced ref exists in the model it claims to be part of.
    for (const ref of statement.producedObjects) {
      const bag: Record<Id, unknown> = model.objects[ref.type];
      if (bag[ref.id] === undefined) {
        problems.push(`statement ${String(index)} produced ${ref.type} ${ref.id}, which is not in the model`);
      }
    }
  }

  const counted = IMPORT_STATEMENT_STATUSES.reduce(
    (total, status) => total + report.countsByStatus[status],
    0,
  );
  if (counted !== report.statementCount) problems.push('countsByStatus does not add up');

  for (const status of IMPORT_STATEMENT_STATUSES) {
    const actual = report.statements.filter((s) => s.status === status).length;
    if (actual !== report.countsByStatus[status]) {
      problems.push(`countsByStatus.${status} is ${String(report.countsByStatus[status])}, not ${String(actual)}`);
    }
  }

  return problems;
}

export const IMPORT_CHECKS: readonly ConformanceCheck[] = [
  {
    id: 'import/accounts-for-every-statement',
    requires: 'importer',
    run: async (ctx) => {
      const problems: string[] = [];
      for (const fixture of requireFixtures(ctx)) {
        const result = await runImport(ctx, fixture);
        expect(result.report.statementCount).toBeGreaterThan(0);
        problems.push(...assertReportShape(result.report, result.model).map((p) => `${fixture.name}: ${p}`));

        // `objectCounts` drives "will create 12 tables, 34 columns, 8 links" (§9.1), so it
        // has to be the truth about the model and not a running tally that drifted.
        const actual = objectCounts(result.model);
        for (const [type, count] of Object.entries(result.report.objectCounts)) {
          if (actual[type as IrObjectType] !== count) {
            problems.push(`${fixture.name}: objectCounts.${type} is ${String(count)}, not ${String(actual[type as IrObjectType])}`);
          }
        }
      }
      expect(problems).toEqual([]);
    },
  },
  {
    id: 'import/reasons-present',
    requires: 'importer',
    run: async (ctx) => {
      const problems: string[] = [];
      for (const fixture of requireFixtures(ctx)) {
        const { report } = await runImport(ctx, fixture);

        // Invariant 3: anything that is not 'applied' says why, in words a user can read.
        for (const statement of report.statements) {
          if (statement.status === 'applied') continue;
          if (statement.reason === null || statement.reason.trim().length === 0) {
            problems.push(`${fixture.name}: ${statement.kind} is ${statement.status} with no reason`);
          }
        }

        // Asserted EXACTLY, so a regression that silently starts dropping CREATE TRIGGER
        // fails here rather than showing up as a missing table months later.
        if (fixture.expectNotApplied !== undefined) {
          const actual = report.statements
            .filter((statement) => statement.status !== 'applied')
            .map((statement) => statement.kind)
            .sort();
          expect([...fixture.expectNotApplied].sort()).toEqual(actual);
        }
      }
      expect(problems).toEqual([]);
    },
  },
  {
    id: 'import/never-throws',
    requires: 'importer',
    run: async (ctx) => {
      const fixture = requireFixtures(ctx)[0];
      if (fixture === undefined) return;

      for (const source of HOSTILE_SOURCES) {
        // Invariant 4. An importer that throws here takes the whole preview dialog with it,
        // and the user is left with "something went wrong" over a file they can see.
        const result: ImportResult = await runImport(ctx, fixture, source);
        expect(result.report.statements.length).toBe(result.report.statementCount);
        for (const statement of result.report.statements) {
          if (statement.status === 'applied') continue;
          expect(statement.reason).not.toBeNull();
        }
      }

      // A source the parser cannot even split is ONE failed statement, not zero and not an
      // exception: "something is wrong with this file" must reach the report.
      const broken = await runImport(ctx, fixture, 'CREATE TABL oops (id int);');
      expect(broken.report.statementCount).toBeGreaterThan(0);
      expect(broken.report.countsByStatus.applied).toBe(0);
    },
  },
  {
    id: 'import/deterministic',
    requires: 'importer',
    run: async (ctx) => {
      for (const fixture of requireFixtures(ctx)) {
        // Same source, same options, same seeded id factory — so the two results are
        // comparable down to the ids, which is what lets core diff a re-import.
        const first = await runImport(ctx, fixture);
        const second = await runImport(ctx, fixture);
        expect(second.model).toEqual(first.model);
        expect(second.report).toEqual(first.report);
        expect(second.diagnostics).toEqual(first.diagnostics);
      }
    },
  },
  {
    id: 'props/accept-importer-output',
    requires: 'importer',
    run: async (ctx) => {
      for (const fixture of requireFixtures(ctx)) {
        const result = await runImport(ctx, fixture);
        // §6: the importer writes `engineProps` through the same schemas the write path
        // validates against. A bag the engine's own importer produces and its own schemas
        // reject is a 422 on the very next edit of an imported object.
        assertPropsAccepted(ctx, result.model, `import ${fixture.name}`);
      }
    },
  },
  {
    id: 'props/accept-exporter-roundtrip',
    requires: 'importer+exporter',
    run: async (ctx) => {
      for (const fixture of requireFixtures(ctx)) {
        const imported = await runImport(ctx, fixture);
        const exported = await runExport(ctx, ctx.fixtures.redactForExport(imported.model));
        const reimported = await runImport(ctx, fixture, renderExport(exported), 're');
        assertPropsAccepted(ctx, reimported.model, `export round trip ${fixture.name}`);
      }
    },
  },
  {
    id: 'roundtrip/ddl-ir-ddl',
    requires: 'importer+exporter',
    run: async (ctx) => {
      for (const fixture of requireFixtures(ctx)) {
        const first = await runImport(ctx, fixture);
        const exported = await runExport(ctx, ctx.fixtures.redactForExport(first.model));
        expect(exported.incomplete).toBe(false);

        const second = await runImport(ctx, fixture, renderExport(exported), 're');

        // MEANING, NOT FORMATTING: the two IRs are compared by name and shape, never by id —
        // the second import minted its own — and never by statement text.
        expect(structuralDigest(second.model)).toEqual(structuralDigest(first.model));
        expect(objectCounts(second.model)).toEqual(objectCounts(first.model));
      }
    },
  },
  {
    id: 'roundtrip/idempotent',
    requires: 'importer+exporter',
    run: async (ctx) => {
      for (const fixture of requireFixtures(ctx)) {
        const first = await runImport(ctx, fixture);
        const once = renderExport(await runExport(ctx, ctx.fixtures.redactForExport(first.model)));
        const second = await runImport(ctx, fixture, once, 're');
        const twice = renderExport(await runExport(ctx, ctx.fixtures.redactForExport(second.model)));

        // The DDL reaches a fixed point after ONE round trip. Without this, an exporter that
        // renders `varchar(255)` and an importer that reads it back as `character varying`
        // both pass their own checks and the pair drifts a little on every re-import.
        expect(twice).toBe(once);
      }
    },
  },
];

