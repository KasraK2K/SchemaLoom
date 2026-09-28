import { expect } from 'vitest';
import type { QueryValidationResult } from '../query.js';
import type { ConformanceCheck } from './check.js';
import type { CheckContext } from './context.js';

/**
 * Doc 03 §12 — the query validator's three checks. They run against `fixtures.redactedModel`
 * because that is the only model a query validator is ever given (§2.1): a fixture query that
 * names the stub or the masked field is how "a hidden object and a typo are the same" (doc 05
 * P8) gets executed rather than asserted in prose.
 */

function validate(ctx: CheckContext, query: string): Promise<QueryValidationResult> {
  const validator = ctx.engine.queryValidator;
  if (validator === undefined) throw new Error('unreachable: requires queryValidator');
  return validator.validate({
    query,
    model: ctx.fixtures.redactedModel,
    context: ctx.engineContext,
  });
}

/** Inputs chosen to break a parser or a walker: nothing, only separators, unterminated
 *  quotes, a stray paren, multi-byte text before an error, and a keyword soup. */
const HOSTILE = [
  '',
  ';;;',
  'SELECT (',
  'SELECT * FROM "unterminated',
  "SELECT 'é' FROM WHERE",
  'SELECT 1; SELEC 2; SELECT 3',
  ')))(((',
  'FROM FROM FROM',
];

export const QUERY_CHECKS: readonly ConformanceCheck[] = [
  {
    id: 'query/fixtures-resolve',
    requires: 'queryValidator',
    run: async (ctx) => {
      expect(ctx.fixtures.queries.length).toBeGreaterThan(0);
      const entities = ctx.fixtures.redactedModel.objects.entity;
      for (const fixture of ctx.fixtures.queries) {
        const result = await validate(ctx, fixture.query);
        const touched = result.touchedEntityIds.map((id) => entities[id]?.name);
        const unknown = result.identifiers
          .filter((i) => i.status === 'unknown')
          .map((i) => i.text);
        expect({ name: fixture.name, parsed: result.parsed, touched, unknown }).toEqual({
          name: fixture.name,
          parsed: fixture.expect.parsed,
          touched: fixture.expect.touchedEntityNames,
          unknown: fixture.expect.unknownIdentifiers,
        });
      }
    },
  },
  {
    id: 'query/unknown-has-range',
    requires: 'queryValidator',
    run: async (ctx) => {
      let seen = 0;
      for (const fixture of ctx.fixtures.queries) {
        const result = await validate(ctx, fixture.query);
        for (const identifier of result.identifiers) {
          // The range must cover exactly the text — CodeMirror underlines off it.
          expect(fixture.query.slice(identifier.range.start, identifier.range.end)).toBe(
            identifier.text,
          );
          if (!['unknown', 'ambiguous', 'not-visible'].includes(identifier.status)) continue;
          seen += 1;
          expect(identifier.messageCode).not.toBeNull();
          expect(ctx.engine.diagnosticMessages[identifier.messageCode ?? '']).toBeDefined();
          expect(identifier.suggestions.length).toBeLessThanOrEqual(3);
        }
      }
      // A fixture set with no unknown identifier leaves this check with no teeth.
      expect(seen).toBeGreaterThan(0);
    },
  },
  {
    id: 'query/never-throws',
    requires: 'queryValidator',
    run: async (ctx) => {
      for (const query of HOSTILE) {
        const result = await validate(ctx, query);
        for (const error of result.parseErrors) {
          expect(error.range.start).toBeGreaterThanOrEqual(0);
          expect(error.range.end).toBeLessThanOrEqual(query.length);
          expect(error.range.start).toBeLessThanOrEqual(error.range.end);
        }
        if (!result.parsed) expect(result.parseErrors.length).toBeGreaterThan(0);
        // No probe is ever supplied, so nothing can be reported as hidden (§12.1).
        expect(result.hiddenReferences).toEqual([]);
      }
    },
  },
];
