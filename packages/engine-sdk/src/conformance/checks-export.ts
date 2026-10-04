import { expect } from 'vitest';
import { ORM_EXPORT_FORMATS } from '../capabilities.js';
import { EXPORT_PHASE_RANK, type ExportResult } from '../exporter.js';
import type { ConformanceCheck } from './check.js';
import { allObjects, renderExport, reorderModel, runExport } from './io-context.js';

/**
 * Doc 03 §10 — the exporter's six checks.
 *
 * They run against `fixtures.redactedModel`, and that is the point rather than a convenience:
 * §17 requires that fixture to carry a stub entity, a masked field, a badge-only index and
 * constraint and a `propsRedacted` object, so every export check is simultaneously a check
 * that redaction survived the exporter. An exporter tested only on a clean model is an
 * exporter whose permission behaviour has never been executed.
 */

function bodies(result: ExportResult): readonly string[] {
  return result.statements.map((statement) => statement.text);
}

export const EXPORT_CHECKS: readonly ConformanceCheck[] = [
  {
    id: 'export/deterministic',
    requires: 'exporter',
    run: async (ctx) => {
      const first = await runExport(ctx, ctx.fixtures.redactedModel);
      const second = await runExport(ctx, ctx.fixtures.redactedModel);
      expect(first.statements.length).toBeGreaterThan(0);
      // Byte-identical, not merely equivalent: §10.1's whole purpose is that diffing two
      // exports is a real diff of the schema.
      expect(renderExport(second)).toBe(renderExport(first));
      expect(second.statements).toEqual(first.statements);
      expect(second.incomplete).toBe(first.incomplete);
      expect(second.separator).toBe(first.separator);
    },
  },
  {
    id: 'export/order-independent',
    requires: 'exporter',
    run: async (ctx) => {
      const straight = await runExport(ctx, ctx.fixtures.redactedModel);
      const shuffled = await runExport(ctx, reorderModel(ctx.fixtures.redactedModel));
      // "re-ordering the arrays inside the IR changes nothing" (§10.1). An exporter that
      // iterates `Object.keys` passes every other check and fails this one.
      expect(renderExport(shuffled)).toBe(renderExport(straight));
    },
  },
  {
    id: 'export/phases-ordered',
    requires: 'exporter',
    run: async (ctx) => {
      const result = await runExport(ctx, ctx.fixtures.redactedModel);

      expect(result.statements.map((s) => s.ordinal)).toEqual(
        result.statements.map((_, index) => index),
      );

      const ranks = result.statements.map((s) => EXPORT_PHASE_RANK[s.phase]);
      const outOfOrder = ranks
        .map((rank, index) => ({ rank, previous: ranks[index - 1] ?? rank, index }))
        .filter((entry) => entry.rank < entry.previous)
        .map((entry) => `statement ${String(entry.index)} goes backwards in the phase order`);
      expect(outOfOrder).toEqual([]);
    },
  },
  {
    id: 'export/comments-from-docs',
    requires: 'exporter',
    run: async (ctx) => {
      const model = ctx.fixtures.redactedModel;
      const documented = [
        ...Object.values(model.objects.entity),
        ...Object.values(model.objects.field),
      ].filter((object) => object.doc !== null && object.restricted !== true);

      // A fixture with no documentation cannot exercise §10.2 at all, and a check that passes
      // on an empty set is the silent pass §17 exists to prevent.
      expect(documented.length).toBeGreaterThan(0);

      const withComments = await runExport(ctx, model, { includeComments: true });
      const commentStatements = withComments.statements.filter((s) => s.phase === 'comments');
      expect(commentStatements.length).toBeGreaterThan(0);

      // Every comment names an object that IS in the export, and carries its ref.
      for (const statement of commentStatements) {
        expect(statement.target).not.toBeNull();
      }
      const commented = new Set(commentStatements.map((s) => s.target?.id));
      const missing = documented
        .filter((object) => !commented.has(object.id))
        .map((object) => object.id);
      expect(missing).toEqual([]);

      // …and the flag actually gates it (§10.2: core hides the checkbox off the same feature
      // atom the exporter reads, so the two cannot disagree).
      const without = await runExport(ctx, model, { includeComments: false });
      expect(without.statements.filter((s) => s.phase === 'comments')).toEqual([]);
    },
  },
  {
    id: 'export/skips-restricted',
    requires: 'exporter',
    run: async (ctx) => {
      const model = ctx.fixtures.redactedModel;
      const restricted = new Set(
        allObjects(model)
          .filter((entry) => entry.object.restricted === true)
          .map((entry) => entry.object.id),
      );
      // The fixture must actually hide something, or this check proves nothing.
      expect(restricted.size).toBeGreaterThan(0);

      const result = await runExport(ctx, model);

      // No statement is ABOUT a restricted object: a stub entity, a masked field, a
      // badge-only index or constraint, or a link into a stub (§10.3 rules 1 and 2).
      const leaked = result.statements
        .filter((statement) => statement.target !== null && restricted.has(statement.target.id))
        .map((statement) => `${statement.kind}: ${statement.text}`);
      expect(leaked).toEqual([]);

      // And no statement carries a blank identifier, which is the shape every redacted object
      // has: emitting a masked field as `"" "" NOT NULL` would satisfy the rule above while
      // producing exactly the broken artefact §10.3 rule 2 forbids.
      const blank = bodies(result).filter((text) => text.includes('""'));
      expect(blank).toEqual([]);
    },
  },
  {
    id: 'export/redaction-is-announced',
    requires: 'exporter',
    run: async (ctx) => {
      const redacted = await runExport(ctx, ctx.fixtures.redactedModel);

      // The §17 fixture hides objects, so this export must be incomplete and must say so —
      // once, in the header, with no count and no names (§10.3 rules 3 and 4).
      expect(redacted.incomplete).toBe(true);
      const header = redacted.statements.filter((statement) => statement.phase === 'header');
      expect(header).toHaveLength(1);
      expect(header[0]?.target).toBeNull();

      // …and no per-object diagnostic enumerating what was hidden, because a list of `info`
      // diagnostics is a count with extra steps.
      expect(redacted.diagnostics).toEqual([]);

      // The announcement is not unconditional decoration: the SAME model with nothing hidden
      // produces no header and a complete export. `redactForExport` mints that through the
      // real `redact` with a permissive context, so the two sides of this comparison differ
      // only in what the viewer may see.
      const clean = await runExport(ctx, ctx.fixtures.redactForExport(ctx.fixtures.referenceModel));
      expect(clean.statements.filter((statement) => statement.phase === 'header')).toEqual([]);
      expect(clean.incomplete).toBe(false);
    },
  },
  {
    // Phase 8 §4 — an ORM format an engine declares must work on its fixtures, hidden objects
    // included. The writers are shared, so this mostly catches a dialect's type table.
    id: 'export/orm-formats-build',
    requires: 'exporter',
    run: async (ctx) => {
      const formats = ctx.engine.capabilities.exportFormats.filter((f) =>
        ORM_EXPORT_FORMATS.some((orm) => orm.id === f.id),
      );
      const model = ctx.fixtures.redactedModel;
      const restricted = new Set(
        allObjects(model)
          .filter((entry) => entry.object.restricted === true)
          .map((entry) => entry.object.id),
      );
      for (const { id } of formats) {
        const clean = await runExport(
          ctx,
          ctx.fixtures.redactForExport(ctx.fixtures.referenceModel),
          {
            format: id,
          },
        );
        expect(clean.statements.length).toBeGreaterThan(0);
        expect(clean.incomplete).toBe(false);
        expect(clean.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);

        const redacted = await runExport(ctx, model, { format: id });
        expect(redacted.incomplete).toBe(true);
        expect(redacted.diagnostics).toEqual([]);
        const leaked = redacted.statements
          .filter((s) => s.target !== null && restricted.has(s.target.id))
          .map((s) => `${id} ${s.kind}: ${s.text}`);
        expect(leaked).toEqual([]);
      }
    },
  },
];
